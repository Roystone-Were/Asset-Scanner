// Removes leftover end-to-end test assets (item_id like 'SYNC-TEST-%').
// Dry run by default: prints the matched rows and deletes nothing. Pass --apply
// to delete them. Matching is on item_id only — a title filter would happily
// purge a real asset called "E2E-..." .
//   node scripts/clean-e2e-assets.mjs            # report
//   node scripts/clean-e2e-assets.mjs --apply    # delete
import fs from 'fs';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const PATTERN = 'SYNC-TEST-%';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  if (!m) throw new Error('bad SUPABASE_DB_URL');
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL) });
await c.connect();

// Each hard delete queues a 'delete' outbox row, which the sync worker turns
// into a SharePoint DELETE (its graph_item_id is snapshotted on the row).
const found = await c.query(
  `select item_id, title, serial, status, graph_item_id, deleted_at
     from public.assets where item_id like $1 order by item_id`,
  [PATTERN]
);

if (!found.rowCount) {
  console.log(`no assets match item_id like '${PATTERN}'`);
  await c.end();
  process.exit(0);
}

console.log(`${found.rowCount} asset(s) match item_id like '${PATTERN}':`);
for (const r of found.rows) {
  console.log(
    `  ${r.item_id}  title=${r.title ?? ''}  serial=${r.serial ?? ''}  status=${r.status ?? ''}` +
    `  graph_item_id=${r.graph_item_id ?? ''}${r.deleted_at ? '  (binned)' : ''}`
  );
}

if (!APPLY) {
  console.log('dry run - nothing deleted. Re-run with --apply to delete these rows.');
} else {
  const del = await c.query('delete from public.assets where item_id like $1 returning item_id', [PATTERN]);
  console.log(`deleted ${del.rowCount} asset(s); their outbox rows will remove the SharePoint items`);
}

await c.end();
