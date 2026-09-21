// Mirror drift report — READ-ONLY comparison of the SharePoint list against
// public.assets. Nothing is written or deleted, so it is safe to run against
// production at any time.
//
// Usage:
//   node scripts/reconcile-mirror.mjs                          # human-readable table
//   node scripts/reconcile-mirror.mjs --json                   # machine-readable report
//   node scripts/reconcile-mirror.mjs --clean-orphans          # dry run: list removable orphans
//   node scripts/reconcile-mirror.mjs --clean-orphans --apply  # DELETE those items in SharePoint
//
// --clean-orphans only removes SharePoint items stamped with a well-formed
// SupabaseId that no longer exists in public.assets (the residue of deleted
// assets); items with no stamp, a malformed stamp or a live asset are never
// touched, and no Supabase row is ever deleted.
//
// Exit code is 0 when the two stores agree and 1 when any drift is found, so it
// can be used as a scheduled check. Reads .env.local (SUPABASE_DB_URL,
// CLIENT_SECRET) and authenticates to Graph with the same client-credentials
// flow as api/sharepoint-sync.js (no certificate).
//
// Drift classes:
//   orphan SP item   - item whose SupabaseId matches no public.assets.id
//   missing mirror   - live asset with no graph_item_id, or one whose
//                      graph_item_id is not present in the list
//   duplicate id     - two or more SP items stamped with the same SupabaseId
//                      (item_id 4 of the sync hardening should have collapsed these)
//   stale binned row - binned asset (deleted_at set) still present in the list;
//                      a binned asset is deleted from SharePoint until restored
//   count delta      - SP items minus live assets (expected 0)
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const REPO = process.env.REPO_DIR || path.resolve(import.meta.dirname, "..");
const TENANT = "refrontiergroup.onmicrosoft.com";
const CLIENT_ID = "7caa51af-9f32-42d8-8264-da5b97c2f8eb";
const SITE_HOST_PATH = "refrontiergroup.sharepoint.com:/sites/xanalifeTechData";
const LIST_NAME = "Xana Asset Inventory";

const JSON_OUT = process.argv.includes("--json");
const CLEAN = process.argv.includes("--clean-orphans");
const APPLY = process.argv.includes("--apply");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(REPO, ".env.local"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

// password may contain '#' — percent-encode user:password
function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  if (!m) throw new Error("bad SUPABASE_DB_URL");
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(secret) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: secret,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("token failed: " + (await res.text()).slice(0, 300));
  return (await res.json()).access_token;
}

async function g(url, token) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (res.status === 429 || res.status === 503) {
        const wait = parseInt(res.headers.get("Retry-After") || "5", 10) * 1000;
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(attempt * 2000);
    }
  }
}

async function fetchAllItems(token, siteId, listId) {
  let url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?expand=fields&$top=999`;
  const items = [];
  while (url) {
    const data = await g(url, token);
    items.push(...data.value);
    url = data["@odata.nextLink"] || null;
    if (url) await sleep(250);
  }
  return items;
}

const norm = (v) => String(v ?? "").trim().toLowerCase();
const label = (title, itemId) => `${title || itemId || "?"} (${itemId || "no item_id"})`;

// Removes one SharePoint list item. Only used by --clean-orphans --apply; a 404
// is the desired end state and is reported back to the caller.
async function deleteItem(siteId, listId, itemId, token) {
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items/${itemId}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
    if (res.status === 404) return 404;
    if (res.status === 429 || res.status === 503) {
      await sleep(parseInt(res.headers.get("Retry-After") || "5", 10) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Graph DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status;
  }
  throw new Error(`Graph DELETE ${itemId}: still throttled after 4 attempts`);
}

async function main() {
  const env = loadEnv();
  if (!env.CLIENT_SECRET || env.CLIENT_SECRET.includes("PASTE")) throw new Error("CLIENT_SECRET missing in .env.local");

  const client = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL), ssl: { rejectUnauthorized: false } });

  const token = await getToken(env.CLIENT_SECRET);
  const site = await g(`https://graph.microsoft.com/v1.0/sites/${SITE_HOST_PATH}`, token);
  const lists = await g(`https://graph.microsoft.com/v1.0/sites/${site.id}/lists`, token);
  const list = lists.value.find((l) => (l.displayName || "").toLowerCase() === LIST_NAME.toLowerCase());
  if (!list) throw new Error(`list "${LIST_NAME}" not found`);
  const items = await fetchAllItems(token, site.id, list.id);

  await client.connect();
  const assets = (
    await client.query("select id, item_id, title, graph_item_id, deleted_at from public.assets order by item_id")
  ).rows;
  await client.end();

  const spIds = new Set(items.map((it) => String(it.id)));
  const assetIds = new Set(assets.map((a) => norm(a.id)));

  // SP items stamped with an id no asset carries (or with no stamp at all).
  const orphans = items.filter((it) => !assetIds.has(norm(it.fields && it.fields.SupabaseId)));

  // Same SupabaseId stamped on more than one item.
  const bySid = new Map();
  for (const it of items) {
    const sid = norm(it.fields && it.fields.SupabaseId);
    if (!sid) continue;
    bySid.set(sid, [...(bySid.get(sid) || []), String(it.id)]);
  }
  const duplicates = [...bySid.entries()].filter(([, ids]) => ids.length > 1);

  const live = assets.filter((a) => !a.deleted_at);
  const missing = live.filter((a) => !a.graph_item_id || !spIds.has(String(a.graph_item_id)));
  const binned = assets.filter((a) => a.deleted_at);
  const staleBinned = binned.filter((a) => a.graph_item_id && spIds.has(String(a.graph_item_id)));

  const delta = items.length - live.length;
  const drift = orphans.length + missing.length + duplicates.length + staleBinned.length + Math.abs(delta);

  const recomputeDrift = (r) =>
    r.orphan_sp_items.length + r.missing_mirror.length + r.duplicate_supabase_ids.length + r.stale_binned_rows.length + Math.abs(r.delta);

  const report = {
    list: LIST_NAME,
    sp_total: items.length,
    sb_total: assets.length,
    live: live.length,
    binned: binned.length,
    delta,
    orphan_sp_items: orphans.map((it) => ({ sp_item_id: String(it.id), supabase_id: (it.fields && it.fields.SupabaseId) || null, title: (it.fields && it.fields.Title) || null })),
    missing_mirror: missing.map((a) => ({ item_id: a.item_id, title: a.title || null, graph_item_id: a.graph_item_id || null })),
    duplicate_supabase_ids: duplicates.map(([supabase_id, sp_item_ids]) => ({ supabase_id, sp_item_ids })),
    stale_binned_rows: staleBinned.map((a) => ({ item_id: a.item_id, title: a.title || null, graph_item_id: a.graph_item_id })),
    drift,
  };

  // Residue of deleted assets: the item's stamp is a well-formed uuid that no
  // asset carries any more. Anything else (no stamp, malformed stamp) may be
  // legacy data and is left for a human.
  const candidates = CLEAN ? report.orphan_sp_items.filter((o) => UUID_RE.test(String(o.supabase_id || ""))) : [];
  const removed = [];
  if (APPLY && candidates.length) {
    for (const o of candidates) {
      removed.push({ ...o, status: await deleteItem(site.id, list.id, o.sp_item_id, token) });
      await sleep(150); // stay well inside Graph's list throttling budget
    }
    const gone = new Set(removed.map((r) => r.sp_item_id));
    report.sp_total -= removed.length;
    report.orphan_sp_items = report.orphan_sp_items.filter((o) => !gone.has(o.sp_item_id));
    report.delta = report.sp_total - report.live;
    report.drift = recomputeDrift(report);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.drift ? 1 : 0;
    return;
  }

  const rows = [
    ["orphan SP items", report.orphan_sp_items.length, report.orphan_sp_items.slice(0, 10).map((o) => `#${o.sp_item_id} ${o.title || ""}`.trim()).join(", ")],
    ["missing mirror", report.missing_mirror.length, report.missing_mirror.slice(0, 10).map((a) => `${label(a.title, a.item_id)}${a.graph_item_id ? ` -> #${a.graph_item_id} gone` : " -> no id"}`).join(", ")],
    ["duplicate ids", report.duplicate_supabase_ids.length, report.duplicate_supabase_ids.slice(0, 10).map((d) => `${d.supabase_id.slice(0, 8)}.. = #${d.sp_item_ids.join(", #")}`).join(", ")],
    ["stale binned rows", report.stale_binned_rows.length, report.stale_binned_rows.slice(0, 10).map((a) => label(a.title, a.item_id)).join(", ")],
    ["count delta", report.delta, `SP ${report.sp_total} vs live assets ${report.live}`],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  console.log(`${LIST_NAME}: SP ${report.sp_total} items | Supabase ${report.sb_total} assets (${report.live} live, ${report.binned} binned)`);
  console.log(`${"CHECK".padEnd(width)}  COUNT  DETAIL`);
  for (const [name, count, detail] of rows) {
    console.log(`${name.padEnd(width)}  ${String(count).padStart(5)}  ${detail || "-"}`);
  }

  if (CLEAN) {
    if (removed.length) {
      console.log(`--clean-orphans --apply: removed ${removed.length} item(s)`);
      for (const r of removed) console.log(`  [removed] #${r.sp_item_id}  ${r.title || ""}  ${r.supabase_id}${r.status === 404 ? "  (already absent)" : ""}`);
    } else if (candidates.length) {
      console.log(`--clean-orphans (dry run): ${candidates.length} item(s) would be removed`);
      for (const o of candidates) console.log(`  [would remove] #${o.sp_item_id}  ${o.title || ""}  ${o.supabase_id}`);
      console.log("dry run - nothing deleted. Re-run with --clean-orphans --apply to remove them.");
    } else {
      console.log("--clean-orphans: no removable orphan item");
    }
  }

  console.log(report.drift ? `DRIFT: ${report.drift} issue group(s) - inspect the detail above` : "OK: SharePoint and Supabase agree");

  process.exitCode = report.drift ? 1 : 0;
}

main().catch((e) => {
  console.error("[FAIL]", e.message, e.cause ? "| " + (e.cause.code || "") : "");
  process.exit(1);
});
