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
// remove any leftover E2E test assets (their outbox rows will clean SP too)
await c.query("delete from public.assets where item_id like 'SYNC-TEST-%' or title like 'E2E-%'");
console.log('cleaned test assets');
await c.end();
