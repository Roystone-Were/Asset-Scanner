import fs from 'fs';
import path from 'path';
import pg from 'pg';

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
// password contains '#' — percent-encode user:password
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  if (!m) throw new Error('bad SUPABASE_DB_URL');
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

const env = loadEnv();
const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();
const q = async (sql) => (await c.query(sql)).rows;

console.log('== outbox by op/status ==');
console.log(JSON.stringify(await q("select op,status,count(*)::int n from public.sharepoint_sync group by 1,2 order by 3 desc")));
console.log('== recent failures ==');
console.log(JSON.stringify(await q("select op,status,attempts,left(coalesce(last_error,''),80) err, created_at from public.sharepoint_sync where status='failed' order by created_at desc limit 5"), null, 1));
console.log('== pending rows ==');
console.log(JSON.stringify(await q("select op,status,attempts,created_at from public.sharepoint_sync where status in ('pending','processing') order by created_at desc limit 5"), null, 1));
console.log('== asset count ==');
console.log(JSON.stringify(await q("select count(*)::int n from public.assets")));
try { console.log('== profiles =='); console.log(JSON.stringify(await q("select email, active from public.profiles order by created_at desc limit 10"), null, 1)); } catch (e) { console.log('profiles:', e.message); }
await c.end();
