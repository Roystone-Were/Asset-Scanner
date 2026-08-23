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

// Set claims BOTH ways (json blob + individual keys) to mimic Supabase
await c.query("select set_config('request.jwt.claims', $1, true)", [
  JSON.stringify({ sub: 'f99f8c54-7f71-44cf-9ec0-3db0e2b3322a', email: 'roystone@xanalife.com', role: 'authenticated' }),
]);
await c.query("select set_config('request.jwt.claim.sub', 'f99f8c54-7f71-44cf-9ec0-3db0e2b3322a', true)");
await c.query("select set_config('request.jwt.claim.email', 'roystone@xanalife.com', true)");

const ctx = (await c.query('select auth.uid() as uid, auth.email() as email')).rows;
console.log('auth.uid()/email with claim keys set:', JSON.stringify(ctx));

console.log(JSON.stringify((await c.query(
  "select public.has_role('scanner') as scanner, public.is_allowed_scanner() as allowed"
)).rows));
await c.end();
