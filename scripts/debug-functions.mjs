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
const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();

// What do the live functions actually contain?
const fns = (await c.query(
  "select proname, prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and proname in ('has_role','is_allowed_scanner','is_admin')"
)).rows;
for (const f of fns) console.log('===', f.proname, '===\n', f.prosrc);

// Simulated JWT again + check auth.uid()/auth.email() resolution
await c.query("select set_config('request.jwt.claims', $1, true)", [
  JSON.stringify({ sub: 'f99f8c54-7f71-44cf-9ec0-3db0e2b3322a', email: 'roystone@xanalife.com', role: 'authenticated' }),
]);
const ctx = (await c.query('select auth.uid() as uid, auth.email() as email')).rows;
console.log('auth.uid():', JSON.stringify(ctx));

// Maybe the live has_role is still the OLD definition (0006-era)?
await c.end();
