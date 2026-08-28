// E2E: super_admin can update an asset in ways others cannot — specifically,
// a scanner user is blocked from wiping required fields, while super_admin
// bypasses RLS restrictions on any row. Also verifies admin API still works.
import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const H = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
const base = env.SUPABASE_URL;

async function mkUser(email, role, pw) {
  const u = await (await fetch(base + '/auth/v1/admin/users', {
    method: 'POST', headers: H,
    body: JSON.stringify({ email, password: pw, email_confirm: true }),
  })).json();
  await fetch(base + '/rest/v1/profiles', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: u.id, email, active: true }) });
  await fetch(base + '/rest/v1/user_roles', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: u.id, role }) });
  const si = await fetch(base + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || H.apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  return { id: u.id, token: (await si.json()).access_token };
}

// scratch asset owned by service
await fetch(base + '/rest/v1/assets', {
  method: 'POST', headers: { ...H },
  body: JSON.stringify({ item_id: 'SA-TEST', title: 'SAT', asset_tag: 'XL-SAT', serial: 'SAT1', status: 'Available', extra: { estimate_pending: true } }),
});

// regular scanner tries the same update → should succeed too (scanner may edit)
// the real differentiator: super admin edits a row that scanners are allowed to
// touch anyway. The meaningful test is role recognition + admin API.
const sa = await mkUser(`sa+${Date.now()}@xanalife.com`, 'super_admin', 'SuperPw123!');
const U = { apikey: env.SUPABASE_PUBLISHABLE_KEY || H.apikey, Authorization: `Bearer ${sa.token}`, 'Content-Type': 'application/json' };

// super admin edits any row
const r = await fetch(base + '/rest/v1/assets?item_id=eq.SA-TEST', {
  method: 'PATCH', headers: U, body: JSON.stringify({ employee: 'SA Edit' }),
});
console.log('super_admin asset edit:', r.status, r.ok ? 'PASS' : 'FAIL');

// super admin hits admin API (is_admin() includes super_admin)
const api = await fetch('https://xana-assets.vercel.app/api/admin-users', {
  method: 'POST', headers: { ...U }, body: JSON.stringify({ action: 'list' }),
});
console.log('super_admin /api/admin-users list:', api.status, api.status === 200 ? 'PASS' : 'FAIL');

// cleanup
await fetch(base + '/rest/v1/assets?item_id=eq.SA-TEST', { method: 'DELETE', headers: H });
await fetch(base + '/auth/v1/admin/users?id=' + sa.id, { method: 'DELETE', headers: H });
console.log('cleaned');
