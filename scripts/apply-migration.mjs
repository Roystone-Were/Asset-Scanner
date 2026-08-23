// Applies a Supabase migration via the Management API (same pattern as the
// 0001-0008 rollout harness). Usage: node scripts/apply-migration.mjs supabase/migrations/0009_manual_password_onboarding.sql
import fs from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: node apply-migration.mjs <migration.sql>'); process.exit(1); }
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const projectRef = env.SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!projectRef || !env.SUPABASE_ACCESS_TOKEN) { console.error('need SUPABASE_URL + SUPABASE_ACCESS_TOKEN'); process.exit(1); }

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: fs.readFileSync(file, 'utf8') }),
});
const body = await res.text();
console.log('HTTP', res.status);
console.log(body.slice(0, 2000));
process.exit(res.ok ? 0 : 1);
