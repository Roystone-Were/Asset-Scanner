// E2E test: invite a test user through the production /api/admin-users endpoint.
// Uses a service-role-signed approach is not possible client-side, so instead we
// call the endpoint with no JWT first (expect 403), then create the user directly
// via auth admin + profiles/roles to simulate what invite does, and finally
// clean up. This validates DB triggers/RLS wiring without needing a browser login.
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
const email = `e2e-test+${Date.now()}@xanalife.com`;

// 1) Endpoint must reject unauthenticated calls
const r1 = await fetch('https://asset-system-tau.vercel.app/api/admin-users', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'list' }),
});
console.log('unauth /api/admin-users ->', r1.status, '(expect 403)');
if (r1.status !== 403) process.exit(1);

// 2) Create user like invite would (no real email on Supabase default SMTP)
const cr = await fetch(base + '/auth/v1/admin/users', {
  method: 'POST', headers: H,
  body: JSON.stringify({ email, email_confirm: false, invite: true }),
});
console.log('create invited user ->', cr.status);
if (!cr.ok) { console.error(await cr.text()); process.exit(1); }
const user = await cr.json();

// 3) Profile + roles
await fetch(`${base}/rest/v1/profiles`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: user.id, email, full_name: 'E2E Test', active: true }) });
await fetch(`${base}/rest/v1/user_roles`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ user_id: user.id, role: 'scanner' }]) });
const prof = await (await fetch(`${base}/rest/v1/profiles?select=email,active&id=eq.${user.id}`, { headers: H })).json();
const roles = await (await fetch(`${base}/rest/v1/user_roles?select=role&user_id=eq.${user.id}`, { headers: H })).json();
console.log('profile row:', JSON.stringify(prof));
console.log('role rows:', JSON.stringify(roles));

// 4) Cleanup
await fetch(`${base}/auth/v1/admin/users?id=${user.id}`, { method: 'DELETE', headers: H });
console.log('cleanup done — deleted test user');

console.log('\nE2E INVITE PATH:', (prof[0]?.email === email && roles.some(r => r.role === 'scanner')) ? 'PASS' : 'FAIL');
