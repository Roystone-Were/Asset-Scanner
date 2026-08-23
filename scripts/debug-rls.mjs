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
const q = async (sql, params) => (await c.query(sql, params)).rows;

console.log('== assets RLS policies ==');
console.log(JSON.stringify(await q("select policyname, cmd, roles, qual::text from pg_policies where tablename='assets'"), null, 1));

// find roystone's auth user id and their roles
console.log('== your profile + roles ==');
const prof = await q("select id, email, active from public.profiles where email='roystone@xanalife.com'");
console.log(JSON.stringify(prof));
if (prof.length) {
  console.log(JSON.stringify(await q('select role from public.user_roles where user_id=$1', [prof[0].id])));
}
await c.end();
