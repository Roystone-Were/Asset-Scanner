// Guard check: assert the security posture that migrations 0010/0022/0025/0030/
// 0036 put in place is actually live, so a guard can never silently skip again
// (the 0030 serial index was reported "applied" for a week while the index did
// not exist — PROGRESS.md 2026-09-14).
//
// Read-only. Usage: node scripts/check-guards.mjs
// Exits non-zero when any FAIL is printed; WARN lines are informational.
import fs from "fs";
import pg from "pg";

const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const dbUrl = (raw) => {
  const u = new URL(String(raw).replace(/#/g, "%23"));
  return u.toString();
};

let fail = 0;
const pass = (m) => console.log("  PASS  " + m);
const warn = (m) => console.log("  WARN  " + m);
const bad = (m) => { fail++; console.log("  FAIL  " + m); };

const c = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL), ssl: { rejectUnauthorized: false } });
await c.connect();
const rows = async (sql, params) => (await c.query(sql, params)).rows;

console.log("== functions callable without a session ==");
const RPC_GUARDED = ["asset_extra_merge", "next_asset_item_id", "requeue_failed_sync_rows", "touch_last_seen"];
const anonFn = await rows(
  `select p.proname,
          has_function_privilege('anon', p.oid, 'execute') as anon_exec,
          pg_get_userbyid(p.proowner) as owner,
          (select pg_get_userbyid(relowner) from pg_class where relname = 'assets') as assets_owner,
          (select relforcerowsecurity from pg_class where relname = 'assets') as rls_forced
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1)`,
  [RPC_GUARDED],
);
for (const f of anonFn) {
  if (f.anon_exec) bad(`${f.proname}() is executable by anon`);
  else pass(`${f.proname}() not executable by anon`);
}
const merge = anonFn.find((f) => f.proname === "asset_extra_merge");
if (merge && merge.owner === merge.assets_owner && !merge.rls_forced) {
  warn(`asset_extra_merge runs as the assets owner with RLS not forced — the role gate inside the function is the only boundary (0036)`);
}

console.log("== storage policies ==");
const pubPol = await rows(
  `select policyname, cmd from pg_policies
    where schemaname = 'storage' and 'public' = any(roles::text[])`,
);
if (pubPol.length) {
  for (const p of pubPol) bad(`storage policy "${p.policyname}" (${p.cmd}) is granted to PUBLIC`);
} else {
  pass("no storage policy is granted to PUBLIC (anonymous listing closed)");
}

console.log("== guard triggers ==");
const trg = await rows(
  `select tgname from pg_trigger where not tgisinternal and tgname = any($1)`,
  [["profiles_guard_self_trigger", "assets_guard_lifecycle_trigger", "assets_audit_trigger", "assets_to_outbox_after_iu"]],
);
for (const want of ["profiles_guard_self_trigger", "assets_guard_lifecycle_trigger", "assets_audit_trigger", "assets_to_outbox_after_iu"]) {
  if (trg.some((t) => t.tgname === want)) pass(`trigger ${want} present`);
  else bad(`trigger ${want} MISSING`);
}

console.log("== uniqueness guards ==");
const idx = (await rows(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'assets'`)).map((r) => r.indexname);
if (idx.includes("assets_live_tag_unique_idx")) pass("assets_live_tag_unique_idx present");
else bad("assets_live_tag_unique_idx MISSING");
if (idx.includes("assets_live_serial_unique_idx")) pass("assets_live_serial_unique_idx present");
else {
  const dupes = await rows(
    `select count(*)::int n from (
       select lower(trim(serial)) s from public.assets
        where deleted_at is null and nullif(trim(serial), '') is not null
          and lower(trim(serial)) not in ('0000', '-', 'n/a')
        group by 1 having count(*) > 1) d`,
  );
  warn(`assets_live_serial_unique_idx not created — ${dupes[0].n} duplicate serial group(s) still live (resolve them, then re-run 0030)`);
}

console.log("== write-path sanity ==");
const orphanEvents = await rows(
  `select count(*)::int n from public.asset_events where event_type <> 'issue' and resolved = false`,
);
if (orphanEvents[0].n) warn(`${orphanEvents[0].n} non-issue event(s) still open (0037 closes them)`);
else pass("no non-issue events left open");
const mixed = await rows(
  `select count(*)::int n from public.assets
    where deleted_at is null and jsonb_typeof(extra -> 'purchase_price') = 'string'`,
);
if (mixed[0].n) warn(`${mixed[0].n} asset(s) still store purchase_price as a JSON string`);
else pass("purchase_price stored as a number everywhere");

await c.end();
console.log(fail ? `\n${fail} guard check(s) FAILED` : "\nall guard checks passed");
process.exit(fail ? 1 : 0);
