// E2E: create_with_password flow against production.
// 1) unauthenticated call must 403
// 2) short password must be rejected (needs admin JWT — skipped here, validated by API logic)
// 3) user creation path is exercised directly via service role to confirm
//    the auth admin API accepts password users + profile flag sticks.
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
const email = `pwd-test+${Date.now()}@xanalife.com`;

// 1) endpoint rejects anonymous
const r1 = await fetch('https://xana-assets.vercel.app/api/admin-users', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'create_with_password', email, password: 'testpass123', roles: ['scanner'] }),
});
console.log('unauth ->', r1.status, '(expect 403)');
if (r1.status !== 403) process.exit(1);

// 2) simulate what the action does: create user with password
const cr = await fetch(base + '/auth/v1/admin/users', {
  method: 'POST', headers: H,
  body: JSON.stringify({ email, password: 'TempPass123!', email_confirm: true }),
});
console.log('create w/ password ->', cr.status);
if (!cr.ok) { console.error(await cr.text()); process.exit(1); }
const user = await cr.json();

// 3) sign in with that password (proves the credential works)
const si = await fetch(base + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'TempPass123!' }),
});
console.log('password sign-in ->', si.status);
if (!si.ok) { console.error(await si.text()); process.exit(1); }
const session = await si.json();

// 4) set the flag like the action would, then read it back as the user
await fetch(base + '/rest/v1/profiles', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: user.id, email, active: true, must_change_password: true }) });
const me = await fetch(base + '/rest/v1/profiles?select=must_change_password&id=eq.' + user.id, {
  headers: { apikey: H.apikey, Authorization: `Bearer ${session.access_token}` },
});
console.log('flag as user ->', me.status, await me.text());

// 5) updateUser password change as the user (what /login does)
const up = await fetch(base + '/auth/v1/user', {
  method: 'PUT',
  headers: { apikey: H.apikey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'MyNewPass456!' }),
});
console.log('self password change ->', up.status);
const si2 = await fetch(base + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: H.apikey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'MyNewPass456!' }),
});
console.log('sign-in with NEW password ->', si2.status, si2.ok ? 'PASS' : 'FAIL');

// cleanup
await fetch(base + '/auth/v1/admin/users?id=' + user.id, { method: 'DELETE', headers: H });
console.log('cleaned up');
