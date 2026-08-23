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
await c.query('select set_config($1, $2, true)', [
  'request.jwt.claims',
  JSON.stringify({ sub: 'f99f8c54-7f71-44cf-9ec0-3db0e2b3322a', email: 'roystone@xanalife.com', role: 'authenticated' }),
]);
console.log(JSON.stringify((await c.query(
  'select public.is_super_admin() sa, public.is_admin() a, public.is_allowed_scanner() s'
)).rows));
await c.end();
