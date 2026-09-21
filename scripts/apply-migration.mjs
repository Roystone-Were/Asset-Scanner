// Applies a Supabase migration via the Management API (same pattern as the
// 0001-0008 rollout harness).
//
//   node scripts/apply-migration.mjs supabase/migrations/0039_storage_privacy.sql
//   node scripts/apply-migration.mjs --seed    record every existing file as applied
//   node scripts/apply-migration.mjs --list    show what the ledger says
//
// Since 0038 the run is recorded in public.schema_migrations, so "applied" is a
// fact rather than a memory: migration 0030 returned HTTP 201 for a week while
// the index it was supposed to create did not exist.
import fs from 'fs';
import path from 'path';

const arg = process.argv[2];
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const projectRef = env.SUPABASE_URL?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!projectRef || !env.SUPABASE_ACCESS_TOKEN) { console.error('need SUPABASE_URL + SUPABASE_ACCESS_TOKEN'); process.exit(1); }

async function run(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

if (!arg) {
  console.error('usage: node scripts/apply-migration.mjs <migration.sql> | --seed | --list');
  process.exit(1);
}

if (arg === '--list') {
  const r = await run('select version, applied_at::date as applied from public.schema_migrations order by version');
  console.log(r.ok ? r.body : `HTTP ${r.status} ${r.body}`);
  process.exit(r.ok ? 0 : 1);
}

if (arg === '--seed') {
  // every file that predates the ledger: it was applied by hand, we just record it
  const files = fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  const versions = files.map((f) => f.replace(/\.sql$/, '')).filter((v) => v < '0038');
  const values = versions.map((v) => `('${v}', 'pre-ledger (applied by hand before 0038)')`).join(',');
  const r = await run(
    `insert into public.schema_migrations (version, note) values ${values} on conflict (version) do nothing returning version`,
  );
  console.log('HTTP', r.status);
  console.log(r.ok ? `recorded ${JSON.parse(r.body || '[]').length} of ${versions.length} pre-ledger files` : r.body.slice(0, 500));
  process.exit(r.ok ? 0 : 1);
}

const file = arg;
const version = path.basename(file).replace(/\.sql$/, '');
const res = await run(fs.readFileSync(file, 'utf8'));
console.log('HTTP', res.status);
console.log(res.body.slice(0, 2000));
if (!res.ok) process.exit(1);

// record it; the ledger itself arrives with 0038, so an earlier file just warns
const rec = await run(
  `insert into public.schema_migrations (version, note) values ('${version}', 'applied by scripts/apply-migration.mjs')
   on conflict (version) do update set applied_at = now(), note = excluded.note`,
);
if (!rec.ok) console.log(`(not recorded: ${rec.body.slice(0, 160)})`);
else console.log(`recorded ${version}`);
