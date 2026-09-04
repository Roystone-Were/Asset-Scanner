// E2E: the view-only permission level (asset_viewer with no scanner/admin).
//
// Creates (or reuses) a throwaway account holding asset_viewer ONLY, then
// proves the level is enforced where it matters — in Postgres, not just in
// the UI:
//   A. RLS probes run as `authenticated` with the test user's JWT claims,
//      inside a transaction that is ALWAYS rolled back. Nothing is written,
//      no SharePoint outbox rows are queued, real assets are never touched.
//   B. The same checks over PostgREST with the user's real access token,
//      i.e. exactly the path assets/index.html takes from the browser.
//
// Usage: node scripts/e2e-view-only-test.mjs [--keep-password <pw>]
// The account is left in place so the UI can be eyeballed; remove it from
// Admin -> Users (Remove) when finished.
import fs from 'fs';
import crypto from 'crypto';
import pg from 'pg';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const BASE = env.SUPABASE_URL;
const TEST_EMAIL = 'viewonly.test@xanalife.com';
const pwArg = process.argv.indexOf('--keep-password');
const PASSWORD = pwArg > -1 ? process.argv[pwArg + 1] : 'Vo-' + crypto.randomBytes(6).toString('base64url') + '9!';

const svc = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
}

// ---------------------------------------------------------------------------
// 1. Create / reset the view-only account (mirrors the admin API's
//    create_with_password action, minus the must_change_password flag so the
//    account lands straight on /assets for a manual look).
// ---------------------------------------------------------------------------
async function findUser(email) {
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${BASE}/auth/v1/admin/users?per_page=200&page=${page}`, { headers: svc });
    const d = await r.json();
    const users = d.users || [];
    const hit = users.find((u) => String(u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

console.log('== 1. account ==');
let user = await findUser(TEST_EMAIL);
if (user) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT', headers: svc,
    body: JSON.stringify({ password: PASSWORD, email_confirm: true }),
  });
  check('existing account password reset', r.ok, 'HTTP ' + r.status);
} else {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: svc,
    body: JSON.stringify({ email: TEST_EMAIL, password: PASSWORD, email_confirm: true }),
  });
  if (!r.ok) { console.error(await r.text()); process.exit(1); }
  user = await r.json();
  check('account created', true, user.id);
}

await fetch(`${BASE}/rest/v1/profiles`, {
  method: 'POST', headers: { ...svc, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({
    id: user.id, email: TEST_EMAIL, full_name: 'View Only Test (finance)',
    invited_by: 'e2e-view-only-test', active: true, must_change_password: false,
  }),
});
// exactly one role: asset_viewer
await fetch(`${BASE}/rest/v1/user_roles?user_id=eq.${user.id}`, { method: 'DELETE', headers: svc });
await fetch(`${BASE}/rest/v1/user_roles`, {
  method: 'POST', headers: svc,
  body: JSON.stringify([{ user_id: user.id, role: 'asset_viewer' }]),
});
const rolesBack = await (await fetch(`${BASE}/rest/v1/user_roles?select=role&user_id=eq.${user.id}`, { headers: svc })).json();
check('holds asset_viewer and nothing else', JSON.stringify(rolesBack.map((r) => r.role)) === '["asset_viewer"]', JSON.stringify(rolesBack.map((r) => r.role)));

// ---------------------------------------------------------------------------
// 2. RLS probes as this user, all inside a rolled-back transaction
// ---------------------------------------------------------------------------
console.log('== 2. RLS (rolled back — nothing is written) ==');
const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();
const victim = (await c.query('select id, item_id, status from public.assets limit 1')).rows[0];
await c.query('begin');
await c.query('set local role authenticated');
await c.query("select set_config('request.jwt.claims', $1, true)", [
  JSON.stringify({ sub: user.id, email: TEST_EMAIL, role: 'authenticated' }),
]);
await c.query("select set_config('request.jwt.claim.sub', $1, true)", [user.id]);
await c.query("select set_config('request.jwt.claim.email', $1, true)", [TEST_EMAIL]);

// each probe in its own savepoint so a denial does not abort the batch
async function probe(name, sql, params, expect) {
  await c.query('savepoint p');
  try {
    const r = await c.query(sql, params);
    await c.query('release savepoint p');
    if (expect === 'denied') return check(name, r.rowCount === 0, 'affected ' + r.rowCount + ' rows (0 = blocked)');
    return check(name, r.rowCount > 0, r.rowCount + ' rows');
  } catch (e) {
    await c.query('rollback to savepoint p');
    if (expect === 'denied') return check(name, e.code === '42501', e.code + ' ' + (e.message || '').slice(0, 60));
    return check(name, false, e.code + ' ' + (e.message || '').slice(0, 60));
  }
}

const helpers = (await c.query(
  "select public.has_role('scanner') s, public.has_role('admin') a, public.is_allowed_scanner() w, public.is_admin() ia"
)).rows[0];
check('has_role(scanner) is false', helpers.s === false);
check('has_role(admin) is false', helpers.a === false);
check('is_allowed_scanner() is false  <- the write gate', helpers.w === false);
check('is_admin() is false', helpers.ia === false);

await probe('CAN read assets', 'select id from public.assets limit 5', [], 'allowed');
await probe('CAN read asset_history (History panel)', 'select id from public.asset_history limit 5', [], 'allowed');
await probe('CAN read asset_events (Events panel)', 'select id from public.asset_events limit 5', [], 'allowed');
await probe('CAN read app_choices', 'select value from public.app_choices limit 5', [], 'allowed');
await probe('CANNOT insert an asset', "insert into public.assets(item_id,title,asset_tag) values ('e2e-vo-probe','probe','VO-PROBE')", [], 'denied');
await probe('CANNOT update an asset (Verify / inline edit)', 'update public.assets set status=status where id=$1', [victim.id], 'denied');
const deleteBlocked = await probe('CANNOT delete an asset', 'delete from public.assets where id=$1', [victim.id], 'denied');
await probe('CANNOT log an asset event', "insert into public.asset_events(item_id,event_type,description) values ($1,'note','probe')", [victim.item_id], 'denied');
await probe('CANNOT grant itself a role', "insert into public.user_roles(user_id,role) values ($1,'admin')", [user.id], 'denied');

const seesProfiles = (await c.query('select count(*)::int n from public.profiles')).rows[0].n;
check('sees only its own profile row', seesProfiles === 1, seesProfiles + ' rows visible');
const seesAssets = (await c.query('select count(*)::int n from public.assets')).rows[0].n;
check('sees the whole register (a role grants read since 0029)', seesAssets > 0, seesAssets + ' assets');

// 0029 made reads role-gated. Prove the other side of that here rather than
// only asserting the happy path: an account with no roles must read nothing.
await c.query('savepoint noroles');
await c.query("select set_config('request.jwt.claims',$1,true)", [
  JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', email: 'noroles@example.com', role: 'authenticated' }),
]);
await c.query("select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true)");
const strangerAssets = (await c.query('select count(*)::int n from public.assets')).rows[0].n;
const strangerHist = (await c.query('select count(*)::int n from public.asset_history')).rows[0].n;
check('an account with no roles reads nothing', strangerAssets === 0 && strangerHist === 0, strangerAssets + ' assets, ' + strangerHist + ' history');
await c.query('rollback to savepoint noroles');
// restore this user's claims for anything that follows
await c.query("select set_config('request.jwt.claims',$1,true)", [
  JSON.stringify({ sub: user.id, email: TEST_EMAIL, role: 'authenticated' }),
]);
await c.query("select set_config('request.jwt.claim.sub',$1,true)", [user.id]);

await c.query('rollback');
const stillThere = (await c.query('select status from public.assets where id=$1', [victim.id])).rows[0];
check('probed asset untouched after rollback', stillThere && stillThere.status === victim.status, 'status=' + (stillThere && stillThere.status));
await c.end();

// ---------------------------------------------------------------------------
// 3. Same thing over PostgREST with a real signed-in token (browser path)
// ---------------------------------------------------------------------------
console.log('== 3. PostgREST as the signed-in user ==');
const anon = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: TEST_EMAIL, password: PASSWORD }),
});
check('password sign-in works', si.ok, 'HTTP ' + si.status);
if (!si.ok) { console.error(await si.text()); process.exit(1); }
const { access_token } = await si.json();
const asUser = { apikey: anon, Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

const rd = await fetch(`${BASE}/rest/v1/assets?select=id,item_id,asset_tag,status&limit=3`, { headers: asUser });
const rdRows = rd.ok ? await rd.json() : [];
check('GET assets -> 200 with rows', rd.ok && rdRows.length > 0, 'HTTP ' + rd.status + ', ' + rdRows.length + ' rows');

const target = rdRows[0];
// same-value patch: even if RLS were broken the stored value would not change
const up = await fetch(`${BASE}/rest/v1/assets?id=eq.${target.id}`, {
  method: 'PATCH', headers: { ...asUser, Prefer: 'return=representation' },
  body: JSON.stringify({ status: target.status }),
});
const upRows = up.ok ? await up.json() : null;
check('PATCH asset affects 0 rows (the Verify / edit write)', up.ok && Array.isArray(upRows) && upRows.length === 0, 'HTTP ' + up.status + ', rows ' + (upRows ? upRows.length : 'n/a'));

const ins = await fetch(`${BASE}/rest/v1/assets`, {
  method: 'POST', headers: asUser,
  body: JSON.stringify({ item_id: 'e2e-vo-probe-' + Date.now(), title: 'probe', asset_tag: 'VO-PROBE' }),
});
check('POST asset -> 401/403 (Add Asset write)', ins.status === 401 || ins.status === 403, 'HTTP ' + ins.status);

const ev = await fetch(`${BASE}/rest/v1/asset_events`, {
  method: 'POST', headers: asUser,
  body: JSON.stringify({ item_id: target.item_id, event_type: 'note', description: 'probe' }),
});
check('POST asset_event -> 401/403', ev.status === 401 || ev.status === 403, 'HTTP ' + ev.status);

// Only fire a live DELETE once the rolled-back probe has proved the policy
// blocks it. If that probe had failed this would be a real deletion.
if (deleteBlocked) {
  const del = await fetch(`${BASE}/rest/v1/assets?id=eq.${target.id}`, {
    method: 'DELETE', headers: { ...asUser, Prefer: 'return=representation' },
  });
  const delRows = del.ok ? await del.json() : null;
  check('DELETE asset affects 0 rows', (del.status === 401 || del.status === 403) || (Array.isArray(delRows) && delRows.length === 0), 'HTTP ' + del.status + ', rows ' + (delRows ? delRows.length : 'n/a'));
} else {
  console.log('  SKIP  live DELETE probe — the RLS probe did not prove it is blocked');
}

const stillAlive = await (await fetch(`${BASE}/rest/v1/assets?select=id,status&id=eq.${target.id}`, { headers: svc })).json();
check('target asset still present and unchanged', stillAlive.length === 1 && stillAlive[0].status === target.status, JSON.stringify(stillAlive[0] || null));

const myRoles = await (await fetch(`${BASE}/rest/v1/user_roles?select=role`, { headers: asUser })).json();
check('myRoles() sees ["asset_viewer"] -> canWrite() false', JSON.stringify(myRoles.map((r) => r.role)) === '["asset_viewer"]', JSON.stringify(myRoles));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log('account: ' + TEST_EMAIL + (pwArg > -1 ? '' : '\npassword: ' + PASSWORD));
process.exit(fail ? 1 : 0);
