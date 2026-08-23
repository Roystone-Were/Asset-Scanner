// Verify the jsonb-merge update path works against production:
// sign in as a temp scanner user (service role), patch ONLY Condition on a
// scratch asset, confirm other extras survive, then clean up.
import fs from 'fs';
import pg from 'pg';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}
const H0 = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
const base = env.SUPABASE_URL;

// temp user
const email = `merge-test+${Date.now()}@xanalife.com`;
const user = await (await fetch(base + '/auth/v1/admin/users', {
  method: 'POST', headers: H0,
  body: JSON.stringify({ email, password: 'MergeTest123!', email_confirm: true }),
})).json();
await fetch(base + '/rest/v1/profiles', { method: 'POST', headers: { ...H0, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: user.id, email, active: true }) });
await fetch(base + '/rest/v1/user_roles', { method: 'POST', headers: { ...H0, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: user.id, role: 'scanner' }) });

// session token
const si = await fetch(base + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'MergeTest123!' }),
});
const { access_token } = await si.json();
const U = { apikey: H0.apikey, Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

// scratch asset with two extras
const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();
const tag = `MRG-${Date.now().toString().slice(-6)}`;
const ins = await c.query(
  "insert into public.assets (item_id,title,status,extra) values ($1,$2,'Available',$3::jsonb) returning item_id",
  [`SYNC-TEST-${tag}`, tag, JSON.stringify({ condition: 'New', purchase_date: '2025-01-15', department: 'IT' })]
);
const itemId = ins.rows[0].item_id;
await c.end();

// patch ONLY Condition as the user — mirrors what /assets edit does (RPC merge)
const r = await fetch(base + '/rest/v1/rpc/asset_extra_merge', {
  method: 'POST', headers: U,
  body: JSON.stringify({ p_item_id: itemId, p_patch: { condition: 'Good' } }),
});
console.log('rpc asset_extra_merge ->', r.status);

// read back: purchase_date and department must survive, condition updated
const back = await (await fetch(base + '/rest/v1/assets?item_id=eq.' + itemId + '&select=extra,status', { headers: U })).json();
const ex = back[0]?.extra || {};
const pass = ex.condition === 'Good' && ex.purchase_date === '2025-01-15' && ex.department === 'IT';
console.log('after merge:', JSON.stringify(ex));
console.log('JSONB MERGE:', pass ? 'PASS' : 'FAIL');

// cleanup: delete asset (also fires outbox → SP delete) + user
const svcH = { ...H0 };
await fetch(base + '/rest/v1/assets?item_id=eq.' + itemId, { method: 'DELETE', headers: svcH });
await fetch(base + '/auth/v1/admin/users?id=' + user.id, { method: 'DELETE', headers: H0 });
console.log('cleaned up');
