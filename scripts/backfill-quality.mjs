// Data-quality backfill: run BEFORE applying migration 0013.
// 1. Auto-tags assets with no tag at all as XL-<item_id>  (safe, reversible)
// 2. Reports rows missing purchase price without estimate flag (report only)
// 3. Reports rows missing serial (report only)
import fs from 'fs';
import path from 'path';
import pg from 'pg';

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  if (!m) throw new Error('bad SUPABASE_DB_URL');
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

const APPLY = process.argv.includes('--apply');
const c = new pg.Client({ connectionString: dbUrl(loadEnv().SUPABASE_DB_URL) });
await c.connect();

if (!APPLY) {
  console.log('DRY RUN (pass --apply to write)\n');
}

// 1. Missing tag entirely
const noTag = await c.query(`
  select item_id, title, serial from public.assets
  where coalesce(nullif(asset_tag,''),nullif(title,'')) is null order by item_id`);
console.log(`missing any tag: ${noTag.rowCount}`);
for (const r of noTag.rows.slice(0, 30)) console.log(`  #${r.item_id} title="${r.title || ''}" serial="${r.serial || ''}"`);

// 2. Tag exists but asset_tag column itself is empty (title carries it)
const tagOnlyTitle = await c.query(`
  select count(*)::int n from public.assets where coalesce(nullif(asset_tag,''),'')='' and coalesce(nullif(title,''),'')<>''`);
console.log(`tag lives in title only: ${tagOnlyTitle.rows[0].n}`);

// 3. Missing price WITHOUT estimate flag
const noPrice = await c.query(`
  select item_id, coalesce(nullif(asset_tag,''),title) tag from public.assets
  where coalesce(nullif(extra->>'purchase_price',''),'')=''
    and coalesce(extra->>'estimate_pending','') not in ('true')
  order by item_id`);
console.log(`\nmissing price, not flagged estimate: ${noPrice.rowCount}`);
for (const r of noPrice.rows.slice(0, 40)) console.log(`  #${r.item_id} ${r.tag}`);

// 4. Missing serial
const noSerial = await c.query(`
  select item_id, coalesce(nullif(asset_tag,''),title) tag from public.assets
  where coalesce(nullif(serial,''),'')='' order by item_id`);
console.log(`\nmissing serial: ${noSerial.rowCount}`);
for (const r of noSerial.rows.slice(0, 40)) console.log(`  #${r.item_id} ${r.tag}`);

if (APPLY && noTag.rowCount > 0) {
  const fix = await c.query(`
    update public.assets
       set asset_tag = 'XL-' || item_id,
           title     = coalesce(nullif(title,''), 'XL-' || item_id)
     where coalesce(nullif(asset_tag,''),nullif(title,'')) is null
     returning item_id`);
  console.log(`\nAPPLIED: auto-tagged ${fix.rowCount} assets as XL-<item_id>`);
} else if (!APPLY && noTag.rowCount > 0) {
  console.log('\n(re-run with --apply to auto-tag these as XL-<item_id>)');
}

await c.end();
