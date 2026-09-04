// Bulk-add CCTV cameras to the register.
//
// Dry-run by default; pass --apply to write. Reads a JSON list of
// {site, name, model, mac} and inserts one `assets` row per camera, using the
// MAC as the serial and the branch's existing purchase date so the cameras
// depreciate alongside the rest of that site's kit.
//
//   node scripts/add-cameras.mjs <cameras.json>            # dry run
//   node scripts/add-cameras.mjs <cameras.json> --apply    # write
//
// Every insert queues a SharePoint outbox row and an immediate pg_net POST to
// the sync worker, so rows go in small chunks with a pause to keep the Graph
// burst civil (see 0003_sync_dispatch_and_retry.sql).
import fs from 'fs';
import pg from 'pg';

const LIST = process.argv[2];
const APPLY = process.argv.includes('--apply');
const PRICE = '30400';
const DEPARTMENT = 'IT';
const CONDITION = 'New';
const STATUS = 'In Use';
const ASSET_TYPE = 'Camera';
const USEFUL_LIFE_YEARS = 5;   // must match USEFUL_LIFE_BY_TYPE in js/supabase-client.js
const CHUNK = 10;
const CHUNK_PAUSE_MS = 1500;

// Ubiquiti OUIs already seen in this estate. A MAC outside these is treated as
// a transcription error and blocks the run rather than quietly becoming a serial.
const KNOWN_OUI = new Set(['28704E', '1C6A1B', 'E43883', 'AC8BA9', '58D61F', '0CEA14', '6C63F8']);

if (!LIST) { console.error('usage: node scripts/add-cameras.mjs <cameras.json> [--apply]'); process.exit(1); }

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}
const hex = (s) => String(s).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
const canonMac = (s) => {
  const h = hex(s);
  return h.match(/.{2}/g).join(':');
};
const money = (n) => 'KES ' + Math.round(n).toLocaleString('en-US');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cameras = JSON.parse(fs.readFileSync(LIST, 'utf8')).cameras;
const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();

// ---------------------------------------------------------------------------
// Branch purchase dates + region, read from the register itself: the modal
// value among that branch's existing assets, so cameras inherit whatever the
// rest of the site already carries rather than a hardcoded guess.
// ---------------------------------------------------------------------------
const branchFacts = {};
for (const row of (await c.query(`
  select location,
         mode() within group (order by extra->>'purchase_date') as purchase_date,
         mode() within group (order by extra->>'region')        as region,
         count(*)::int n
  from public.assets
  where location is not null and deleted_at is null
  group by location`)).rows) {
  branchFacts[row.location] = row;
}

// ---------------------------------------------------------------------------
// Validation. Nothing is written unless every camera passes.
// ---------------------------------------------------------------------------
const locations = (await c.query("select value from public.app_choices where category='location'")).rows.map((r) => r.value);
const existingSerials = new Map(
  (await c.query('select asset_tag, serial, location from public.assets where serial is not null and deleted_at is null')).rows
    .map((r) => [hex(r.serial), r])
);
const existingTags = new Set(
  (await c.query("select lower(asset_tag) t from public.assets where asset_tag is not null and asset_tag <> ''")).rows.map((r) => r.t)
);

const problems = [];
const seen = new Map();
for (const cam of cameras) {
  const where = `${cam.site}/${cam.name}`;
  const h = hex(cam.mac);
  if (h.length !== 12) problems.push(`${where}: MAC "${cam.mac}" is not 6 octets`);
  else if (!KNOWN_OUI.has(h.slice(0, 6))) problems.push(`${where}: MAC ${cam.mac} has an unrecognised OUI ${h.slice(0, 6)} - check the source`);
  if (seen.has(h)) problems.push(`${where}: MAC ${cam.mac} duplicates ${seen.get(h)}`);
  else seen.set(h, where);
  const clash = existingSerials.get(h);
  if (clash) problems.push(`${where}: MAC ${cam.mac} is already the serial of ${clash.asset_tag} at ${clash.location}`);
  if (!locations.includes(cam.site)) problems.push(`${where}: "${cam.site}" is not a location in app_choices`);
}
if (problems.length) {
  console.error('REFUSING TO INSERT - ' + problems.length + ' problem(s):');
  for (const p of problems) console.error('  - ' + p);
  await c.end();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Allocate tags: continue the XL-<n> sequence from the current max.
// ---------------------------------------------------------------------------
let maxTag = 0;
for (const t of existingTags) {
  const m = /^xl-(\d+)$/.exec(t);
  if (m) maxTag = Math.max(maxTag, parseInt(m[1], 10));
}
const planned = cameras.map((cam, i) => {
  const tag = 'XL-' + (maxTag + 1 + i);
  const facts = branchFacts[cam.site] || {};
  return {
    ...cam,
    tag,
    serial: canonMac(cam.mac),
    purchase_date: facts.purchase_date || null,
    region: facts.region || null,
  };
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log('\n' + pad('TAG', 8) + pad('SITE', 12) + pad('DEVICE NAME', 24) + pad('MODEL', 17) + pad('SERIAL (MAC)', 19) + pad('PURCHASE DATE', 14) + 'ANNUAL DEP');
console.log('-'.repeat(105));
for (const p of planned) {
  console.log(pad(p.tag, 8) + pad(p.site, 12) + pad(p.name, 24) + pad(p.model, 17) + pad(p.serial, 19) +
    pad(p.purchase_date || '(none)', 14) + money(Number(PRICE) / USEFUL_LIFE_YEARS) + '/yr');
}
const bySite = {};
for (const p of planned) bySite[p.site] = (bySite[p.site] || 0) + 1;
console.log('\nby site: ' + Object.entries(bySite).map(([k, v]) => `${k} ${v}`).join(' | '));
console.log('cameras: ' + planned.length + '   tags: ' + planned[0].tag + ' .. ' + planned[planned.length - 1].tag);
console.log('unit price: ' + money(PRICE) + '   batch cost: ' + money(planned.length * Number(PRICE)));
console.log('useful life: ' + USEFUL_LIFE_YEARS + ' yrs   batch annual depreciation: ' + money(planned.length * Number(PRICE) / USEFUL_LIFE_YEARS));
const undated = planned.filter((p) => !p.purchase_date);
if (undated.length) {
  console.log('\n' + undated.length + ' camera(s) have no purchase date (' +
    [...new Set(undated.map((p) => p.site))].join(', ') + ') - they will read "No data" and hold full book value.');
}

if (!APPLY) {
  console.log('\nDRY RUN - nothing written. Re-run with --apply to insert.');
  await c.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Insert, in chunks, each row taking its item_id from the same RPC the app uses
// ---------------------------------------------------------------------------
let inserted = 0;
for (let i = 0; i < planned.length; i += CHUNK) {
  const batch = planned.slice(i, i + CHUNK);
  await c.query('begin');
  try {
    for (const p of batch) {
      const itemId = (await c.query('select public.next_asset_item_id() as id')).rows[0].id;
      const extra = {
        department: DEPARTMENT,
        condition: CONDITION,
        purchase_price: PRICE,
        estimate_pending: false,
        device_name: p.name,
      };
      if (p.purchase_date) extra.purchase_date = p.purchase_date;
      if (p.region) extra.region = p.region;
      // Custodian, not a person: the estate labels fixed infrastructure this
      // way ("Syokimau Server Room", "TRM Drive Pharmacy"). Leaving it blank
      // makes the exec dashboard count every camera as idle/unassigned stock.
      await c.query(
        `insert into public.assets (item_id, title, asset_tag, asset_type, model, serial, employee, status, location, extra)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [itemId, p.tag, p.tag, ASSET_TYPE, p.model, p.serial, p.site + ' CCTV', STATUS, p.site, JSON.stringify(extra)]
      );
      inserted++;
    }
    await c.query('commit');
    console.log(`inserted ${inserted}/${planned.length} (through ${batch[batch.length - 1].tag})`);
  } catch (err) {
    await c.query('rollback');
    console.error('chunk failed, rolled back:', err.message);
    await c.end();
    process.exit(1);
  }
  if (i + CHUNK < planned.length) await sleep(CHUNK_PAUSE_MS);
}
console.log('\ndone: ' + inserted + ' cameras added.');
const pending = (await c.query("select status, count(*)::int n from public.sharepoint_sync where status <> 'done' group by status")).rows;
console.log('sharepoint outbox not yet drained: ' + (pending.length ? JSON.stringify(pending) : 'none'));
await c.end();
