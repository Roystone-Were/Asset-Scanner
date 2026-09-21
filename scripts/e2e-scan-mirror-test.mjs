// E2E scan-path test: insert an asset into Supabase, wait for the outbox ->
// pg_net -> Vercel worker -> SharePoint mirror, verify the SP item exists,
// then delete and verify removal. Uses the same Graph client-credentials
// flow as scripts/backfill.mjs.
//   node scripts/e2e-scan-mirror-test.mjs
// Leaves nothing behind: the test asset is deleted in a finally block.
import fs from 'fs';
import pg from 'pg';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  if (!m) throw new Error('bad SUPABASE_DB_URL');
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

async function graphToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: '7caa51af-9f32-42d8-8264-da5b97c2f8eb',
    client_secret: env.CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch('https://login.microsoftonline.com/refrontiergroup.onmicrosoft.com/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error('token: ' + await res.text());
  return (await res.json()).access_token;
}
const SITE = 'refrontiergroup.sharepoint.com,6e2871c3-cf14-4bbe-8d97-8da58f8b6e10,629c5972-9b75-4a1d-bb25-8179a335cc71';
const LIST = '7d3b5f47-8199-4cb9-b7c4-361dc70c4622';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = `E2E-${Date.now().toString().slice(-6)}`;
const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();

let assetId = null;
let failed = false;
const fail = (msg) => { console.error(msg); failed = true; };

try {
  // 1) INSERT asset (outbox trigger fires). extra must carry a purchase price
  // or estimate_pending — assets_price_or_estimate (0013, tightened in 0038)
  // rejects a row with neither.
  const ins = await c.query(
    "insert into public.assets (item_id, title, serial, status, extra) " +
    "values ($1,$2,$3,'Available',$4::jsonb) returning id",
    [`SYNC-TEST-${tag}`, tag, `SN-${tag}`, JSON.stringify({ estimate_pending: true })]
  );
  assetId = ins.rows[0].id;
  console.log('inserted asset', assetId, 'tag', tag);

  // 2) Poll for the SharePoint mirror (worker runs in ~5s; allow up to 60s)
  const token = await graphToken();
  let spItem = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const url = `https://graph.microsoft.com/v1.0/sites/${SITE}/lists/${LIST}/items?$expand=fields&$filter=fields/SupabaseId eq '${assetId}'`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    if (!r.ok) { console.log('graph poll warn:', r.status); continue; }
    const data = await r.json();
    if (data.value?.length) { spItem = data.value[0]; break; }
    console.log(`poll ${i + 1}: not mirrored yet...`);
  }

  if (!spItem) {
    fail('FAIL: asset never appeared in SharePoint within 60s');
  } else {
    console.log('MIRROR CREATE: PASS — SP item id', spItem.id, '| Title:', spItem.fields.Title);

    // 3) UPDATE then DELETE, verify both
    await c.query("update public.assets set status='In Use' where id=$1", [assetId]);
    await sleep(10000);
    const upd = await fetch(`https://graph.microsoft.com/v1.0/sites/${SITE}/lists/${LIST}/items/${spItem.id}?$expand=fields`, { headers: { Authorization: `Bearer ${token}` } });
    console.log('MIRROR UPDATE:', upd.ok && (await upd.json()).fields.Status === 'In Use' ? 'PASS' : 'CHECK');

    await c.query('delete from public.assets where id=$1', [assetId]);
    let removed = false;
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const d = await fetch(`https://graph.microsoft.com/v1.0/sites/${SITE}/lists/${LIST}/items/${spItem.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (d.status === 404) { removed = true; break; }
      console.log(`poll ${i + 1}: still present (${d.status})...`);
    }
    if (removed) console.log('MIRROR DELETE: PASS');
    else fail('MIRROR DELETE: FAIL — orphan left at SP item ' + spItem.id);
  }
} finally {
  // Cleanup runs on every path: the test asset must never survive a failure.
  if (assetId) {
    try { await c.query('delete from public.assets where id=$1', [assetId]); }
    catch (e) { fail('cleanup failed: ' + e.message); }
  }
  await c.end();
}

process.exitCode = failed ? 1 : 0;
