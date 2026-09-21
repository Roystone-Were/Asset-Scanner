// SharePoint -> Supabase backfill. Re-runnable: rows are matched to assets by
// the item's SupabaseId stamp (graph_item_id as fallback), the merge never
// replaces extra, and only the outbox rows this run creates are suppressed - so
// it is safe to run against a live register. Supabase-only extras
// (estimate_pending, useful_life, image_url, warranty_months, vendor, po_number)
// survive because extra is merged, and a blank SharePoint field no longer wipes
// a value. SharePoint items that match no asset (orphans) are reported and
// skipped - scripts/reconcile-mirror.mjs is the report for those.
//   node scripts/backfill.mjs
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const REPO = process.env.REPO_DIR || path.resolve(import.meta.dirname, "..");
const TENANT = "refrontiergroup.onmicrosoft.com";
const CLIENT_ID = "7caa51af-9f32-42d8-8264-da5b97c2f8eb";
const SITE_HOST_PATH = "refrontiergroup.sharepoint.com:/sites/xanalifeTechData";
const LIST_NAME = "Xana Asset Inventory";

function loadEnv() {
  const env = {};
  const file = path.join(REPO, ".env.local");
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

function dbUrl(raw) {
  const m = raw.match(/^(postgresql:\/\/)([^:@/]+):([^@]*)@(.*)$/);
  if (!m) throw new Error("bad SUPABASE_DB_URL");
  return `${m[1]}${encodeURIComponent(m[2])}:${encodeURIComponent(m[3])}@${m[4]}`;
}

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
        console.log(`[throttle] ${res.status}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res.json();
    } catch (e) {
      if (e.cause || attempt === 4) {
        if (attempt === 4) throw e;
        console.log(`[retry ${attempt}] ${e.cause?.code || e.message}`);
      }
      await sleep(attempt * 2000);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const trim = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

function mapItem(it) {
  const f = it.fields || {};
  const num = (v) => (v === null || v === undefined || v === "" ? null : parseFloat(v));
  return {
    item_id: String(it.id),
    graph_item_id: String(it.id),
    supabase_id: trim(f.SupabaseId), // link back to public.assets.id (identity)
    title: trim(f.Title),
    asset_tag: trim(f.Title),
    asset_type: trim(f.Asset),
    model: trim(f.Model),
    serial: trim(f.SerialNumber),
    employee: trim(f.EmployeeName),
    status: trim(f.Status),
    location: trim(f.Location),
    extra: {
      department: trim(f.Department),
      employee_number: trim(f.EmployeeNumber),
      purchase_price: num(f.PurchasePrice),
      purchase_date: trim(f.PurchaseDate),
      date_issued: trim(f.DateIssued),
      phone_number: trim(f.PhoneNumber),
      condition: trim(f.Condition),
      ram: trim(f.RAM),
      region: trim(f.Region),
      last_verified: trim(f.LastVerified),
      last_verified_by: trim(f.LastVerifiedBy),
      sp_created: trim(f.Created),
      sp_modified: trim(f.Modified),
    },
  };
}

async function fetchAll(token, siteId, listId) {
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

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const COLS = ["item_id", "graph_item_id", "title", "asset_tag", "asset_type", "model", "serial", "employee", "status", "location", "extra"];

// Columns the run refreshes on an existing asset, with the casts its `values`
// list needs (parameter types are otherwise inferred from the schema).
const UPDATE_COLS = ["graph_item_id", "title", "asset_tag", "asset_type", "model", "serial", "employee", "status", "location"];
const COL_TYPE = { id: "uuid", graph_item_id: "text", title: "text", asset_tag: "text", asset_type: "text", model: "text", serial: "text", employee: "text", status: "text", location: "text", extra: "jsonb" };

async function main() {
  const env = loadEnv();
  if (!env.CLIENT_SECRET || env.CLIENT_SECRET.includes("PASTE")) throw new Error("CLIENT_SECRET missing in .env.local");

  const client = new pg.Client({ connectionString: dbUrl(env.SUPABASE_DB_URL), ssl: { rejectUnauthorized: false } });

  console.log("[1/5] Graph auth…");
  const token = await getToken(env.CLIENT_SECRET);

  console.log("[2/5] resolving site/list…");
  const site = await g(`https://graph.microsoft.com/v1.0/sites/${SITE_HOST_PATH}`, token);
  const lists = await g(`https://graph.microsoft.com/v1.0/sites/${site.id}/lists`, token);
  const list = lists.value.find((l) => (l.displayName || "").toLowerCase() === LIST_NAME.toLowerCase());
  if (!list) throw new Error("list not found");

  console.log("[3/5] fetching all SharePoint items…");
  const items = await fetchAll(token, site.id, list.id);
  console.log(`      fetched ${items.length} items`);

  const rows = items.map(mapItem);
  const skipped = [];

  console.log("[4/5] writing to Supabase (single transaction)…");
  await client.connect();
  await client.query("begin");
  try {
    // The write fires assets_to_outbox_after_iu, which would echo every
    // backfilled row straight back to SharePoint. Remember this transaction's
    // id: rows it creates carry it in xmin, so the suppression below removes
    // exactly this run's rows and never the ones floor staff are creating.
    const txid = (await client.query("select txid_current()::text as xid")).rows[0].xid;

    // Identity. The SharePoint item's SupabaseId stamp is the real link; the
    // list item id (graph_item_id) is the fallback. item_id is only a fallback
    // for assets that were never mirrored - after go-live an app-created asset
    // has its own item_id, and re-matching on it would overwrite an unrelated
    // asset (and an upsert on item_id would insert duplicates).
    const known = await client.query("select id, item_id, graph_item_id from public.assets");
    const byStamp = new Map(known.rows.map((a) => [a.id.toLowerCase(), a.id]));
    const byGraph = new Map(known.rows.filter((a) => a.graph_item_id).map((a) => [String(a.graph_item_id), a.id]));
    const byItem = new Map(known.rows.map((a) => [a.item_id, a.id]));
    const unmappedByItem = new Map(known.rows.filter((a) => !a.graph_item_id).map((a) => [a.item_id, a.id]));

    const updates = [];
    const inserts = [];
    for (const r of rows) {
      const id =
        byStamp.get(String(r.supabase_id || "").toLowerCase()) ||
        byGraph.get(String(r.graph_item_id)) ||
        unmappedByItem.get(r.item_id);
      if (id) updates.push({ id, row: r });
      // An item that matches nothing, whose ids are already taken by some other
      // (already mirrored) asset, cannot be imported without overwriting that
      // asset or breaking the unique indexes: leave it to reconcile-mirror.
      else if (byItem.has(r.item_id) || byGraph.has(String(r.graph_item_id))) skipped.push(r);
      else inserts.push(r);
    }

    // Batched so the transaction's row locks are held for a moment, not for one
    // round trip per asset (floor staff keep editing while this runs).
    for (const part of chunk(updates, 40)) {
      const params = [];
      let p = 0;
      const cols = ["id", ...UPDATE_COLS, "extra"];
      const tuples = part.map(({ id, row }) => {
        const vals = [id, ...UPDATE_COLS.map((k) => row[k]), JSON.stringify(row.extra)];
        return `(${vals.map((v, i) => { params.push(v); return `$${++p}::${COL_TYPE[cols[i]]}`; }).join(",")})`;
      });
      await client.query(
        `update public.assets a set
           graph_item_id = v.graph_item_id, title = v.title, asset_tag = v.asset_tag,
           asset_type = v.asset_type, model = v.model, serial = v.serial, employee = v.employee,
           status = v.status, location = v.location,
           -- Merge, never replace: Supabase-only extras (estimate_pending,
           -- useful_life, image_url, warranty_months, vendor, po_number) are not
           -- mirrored from SharePoint, and blank SharePoint fields must not wipe
           -- a value (that also left rows violating assets_price_or_estimate).
           extra = coalesce(a.extra, '{}'::jsonb) || jsonb_strip_nulls(v.extra),
           updated_at = now()
         from (values ${tuples.join(",")}) as v(${["id", ...UPDATE_COLS, "extra"].join(", ")})
        where a.id = v.id`,
        params
      );
    }

    for (const part of chunk(inserts, 80)) {
      const values = [];
      const params = [];
      let p = 1;
      for (const r of part) {
        values.push(`(${COLS.map((c) => { params.push(c === "extra" ? JSON.stringify(r[c]) : r[c]); return `$${p++}`; }).join(",")})`);
      }
      await client.query(`insert into public.assets (${COLS.join(",")}) values ${values.join(",")}`, params);
    }

    const del = await client.query(
      "delete from public.sharepoint_sync where status = 'pending' and xmin::text = $1 returning id",
      [txid]
    );
    console.log(`      ${updates.length} updated, ${inserts.length} inserted, suppressed ${del.rowCount} backfill outbox rows`);
    for (const r of skipped) {
      console.log(`      [skip] SharePoint item ${r.graph_item_id} (${r.title || "no title"}): no asset matches and item_id ${r.item_id} is taken - see scripts/reconcile-mirror.mjs`);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  }

  console.log("[5/5] verifying…");
  const count = await client.query(
    "select count(*)::int total, count(graph_item_id)::int mirrored, count(distinct item_id)::int distinct_ids from public.assets"
  );
  const outbox = await client.query("select status, count(*)::int n from public.sharepoint_sync group by status");
  const sample = await client.query(
    "select item_id, asset_tag, model, status, location from public.assets order by item_id limit 3"
  );
  console.log("      supabase:", JSON.stringify(count.rows[0]));
  console.log("      outbox:", JSON.stringify(outbox.rows));
  for (const s of sample.rows) console.log("      sample:", JSON.stringify(s));

  // Items that map to no asset are reported as [skip] above; count the rest.
  const expected = items.length - skipped.length;
  const match = count.rows[0].total === expected && count.rows[0].mirrored === expected;
  console.log(match ? "[done] BACKFILL VERIFIED - counts match SharePoint" : "[WARN] count mismatch - investigate");

  await client.end();
}

main().catch(async (e) => {
  console.error("[FAIL]", e.message, e.cause ? "| " + (e.cause.code || "") : "");
  process.exit(1);
});
