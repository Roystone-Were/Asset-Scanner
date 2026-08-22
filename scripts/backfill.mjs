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

  console.log("[4/5] writing to Supabase (single transaction)…");
  await client.connect();
  await client.query("begin");
  try {
    const pre = await client.query("select count(*)::int n from public.sharepoint_sync");
    if (pre.rows[0].n !== 0) throw new Error(`outbox not empty (${pre.rows[0].n} rows) - aborting`);

    for (const part of chunk(rows, 80)) {
      const values = [];
      const params = [];
      let p = 1;
      for (const r of part) {
        values.push(`(${COLS.map((c) => { params.push(c === "extra" ? JSON.stringify(r[c]) : r[c]); return `$${p++}`; }).join(",")})`);
      }
      await client.query(
        `insert into public.assets (${COLS.join(",")}) values ${values.join(",")}
         on conflict (item_id) do update set
           graph_item_id = excluded.graph_item_id, title = excluded.title, asset_tag = excluded.asset_tag,
           asset_type = excluded.asset_type, model = excluded.model, serial = excluded.serial,
           employee = excluded.employee, status = excluded.status, location = excluded.location,
           extra = excluded.extra, updated_at = now()`,
        params
      );
    }

    const del = await client.query(
      "delete from public.sharepoint_sync where status = 'pending' returning id"
    );
    console.log(`      inserted ${rows.length} assets, suppressed ${del.rowCount} backfill outbox rows`);
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

  const match = count.rows[0].total === items.length && count.rows[0].mirrored === items.length;
  console.log(match ? "[done] BACKFILL VERIFIED - counts match SharePoint" : "[WARN] count mismatch - investigate");

  await client.end();
}

main().catch(async (e) => {
  console.error("[FAIL]", e.message, e.cause ? "| " + (e.cause.code || "") : "");
  process.exit(1);
});
