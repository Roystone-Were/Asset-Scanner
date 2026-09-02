// Vercel serverless function — SharePoint sync worker
// Drains public.sharepoint_sync (outbox) into the SharePoint list via Graph.
// Called two ways:
//   1. pg_net trigger on every new outbox row  -> body { ids: ["uuid"] }
//   2. pg_cron retry sweep every 5 minutes     -> body {} (drains everything pending)
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TENANT, CLIENT_ID,
//           CLIENT_SECRET, SITE_URL, LIST_NAME, SYNC_ACCESS_KEY
// Optional: SITE_ID, LIST_ID, SYNC_MAX_ATTEMPTS (default 5), SYNC_BATCH_LIMIT (default 20)

const TENANT    = process.env.TENANT    || "refrontiergroup.onmicrosoft.com";
const CLIENT_ID = process.env.CLIENT_ID || "7caa51af-9f32-42d8-8264-da5b97c2f8eb";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const SITE_URL   = process.env.SITE_URL   || "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData";
const LIST_NAME  = process.env.LIST_NAME  || "Xana Asset Inventory";
const SITE_ID_OVERRIDE = process.env.SITE_ID || "";
const LIST_ID_OVERRIDE = process.env.LIST_ID || "";
const MAX_ATTEMPTS = parseInt(process.env.SYNC_MAX_ATTEMPTS || "5", 10);
const BATCH_LIMIT  = parseInt(process.env.SYNC_BATCH_LIMIT || "20", 10);

const STALE_PROCESSING_MINUTES = 10;

// Supabase column -> SharePoint list field internal name
const FIELD_MAP = {
  title: "Title",
  asset_type: "Asset",
  model: "Model",
  serial: "SerialNumber",
  employee: "EmployeeName",
  status: "Status",
  location: "Location",
};
const EXTRA_MAP = {
  department: "Department",
  employee_number: "EmployeeNumber",
  purchase_price: "PurchasePrice",
  purchase_date: "PurchaseDate",
  date_issued: "DateIssued",
  phone_number: "PhoneNumber",
  condition: "Condition",
  ram: "RAM",
  region: "Region",
  last_verified: "LastVerified",
  last_verified_by: "LastVerifiedBy",
};

// ---------- Supabase (PostgREST) helpers ----------
function sbHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    Authorization: "Bearer " + (process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
    "Content-Type": "application/json",
  };
}

async function sb(path, options = {}) {
  const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/" + path, {
    ...options,
    headers: { ...sbHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text()).slice(0, 300));
  if ((res.headers.get("content-length") || "1") === "0") return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbUpdate(table, filter, body, preferReturn = false) {
  const rows = await sb(`${table}?${filter}`, {
    method: "PATCH",
    headers: preferReturn ? { Prefer: "return=representation" } : {},
    body: JSON.stringify(body),
  });
  return rows;
}

// ---------- HTTP with retry/backoff ----------
// Retries transient conditions only: 429/5xx responses and network-level
// failures. 4xx (bad payload, permissions) surfaces immediately.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpWithRetry(url, options, tries = 4) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, options);
      if ((res.status === 429 || res.status >= 500) && attempt < tries - 1) {
        const retryAfter = parseFloat(res.headers.get("Retry-After"));
        const delay = retryAfter > 0 ? retryAfter * 1000 : 600 * Math.pow(2, attempt) + Math.random() * 300;
        console.log(`[sync] ${res.status} from ${url.split("/")[2]}, backoff ${Math.round(delay)}ms (attempt ${attempt + 1})`);
        await sleepMs(delay);
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      const sig = `${(e.cause && e.cause.code) || ""} ${e.message}`;
      const transient = !e.status && /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|CONNECT_TIMEOUT/i.test(sig);
      if (!transient || attempt >= tries - 1) throw e;
      const delay = 900 * Math.pow(2, attempt) + Math.random() * 400;
      console.log(`[sync] network error (${sig.trim()}), retrying in ${Math.round(delay)}ms`);
      await sleepMs(delay);
      attempt++;
    }
  }
}

let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 120000) return _token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await httpWithRetry(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Graph token failed " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

async function graph(method, url, payload, token, extraHeaders) {
  const res = await httpWithRetry(url, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = await res.text().catch(() => res.statusText);
    try { detail = JSON.parse(detail).error.message || detail; } catch (e) { /* raw */ }
    const err = new Error(`Graph ${res.status}: ${String(detail).slice(0, 250)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let _siteId = SITE_ID_OVERRIDE || "";
let _listId = LIST_ID_OVERRIDE || "";

async function resolveIds(token) {
  if (_siteId && _listId) return;
  if (!_siteId) {
    const u = new URL(SITE_URL);
    const path = u.host + ":" + u.pathname.replace(/\/+$/, "");
    const site = await graph("GET", "https://graph.microsoft.com/v1.0/sites/" + encodeURIComponent(path), undefined, token);
    _siteId = site.id;
  }
  if (!_listId) {
    const lists = await graph("GET", `https://graph.microsoft.com/v1.0/sites/${_siteId}/lists`, undefined, token);
    const list = lists.value.find((l) => (l.displayName || "").toLowerCase() === LIST_NAME.toLowerCase());
    if (!list) throw new Error(`List "${LIST_NAME}" not found`);
    _listId = list.id;
  }
}

function itemsUrl() {
  return `https://graph.microsoft.com/v1.0/sites/${_siteId}/lists/${_listId}/items`;
}

// ---------- Field mapping ----------
function numeric(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function buildSpFields(asset, forInsert) {
  const fields = {};
  // Full-mirror semantics: an explicit null CLEARS the SharePoint field
  // (e.g. offboarding clears EmployeeName), "" normalizes to null, and
  // undefined (key absent from the Supabase row) is left untouched.
  const put = (spName, value) => {
    if (value === undefined) return;
    fields[spName] = value === null || value === "" ? null : value;
  };
  if (forInsert) put("SupabaseId", asset.id);
  fields.Title = asset.title || asset.asset_tag || null;   // Title always managed
  for (const [col, sp] of Object.entries(FIELD_MAP)) {
    if (col === "title") continue;
    put(sp, asset[col]);
  }
  const extra = asset.extra || {};
  for (const [key, sp] of Object.entries(EXTRA_MAP)) {
    if (key === "purchase_price") put(sp, extra[key] === undefined ? undefined : numeric(extra[key]));
    else put(sp, extra[key]);
  }
  return fields;
}

// Idempotency guard: if a previous create attempt committed server-side but
// lost its response (network blip), the retry finds the orphan by its
// SupabaseId fingerprint and adopts it instead of creating a duplicate.
async function findItemBySupabaseId(assetId, token) {
  const filter = encodeURIComponent(`fields/SupabaseId eq '${assetId}'`);
  const data = await graph("GET", `${itemsUrl()}?$filter=${filter}&$select=id`, undefined, token, {
    Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
  });
  return data.value && data.value.length ? String(data.value[0].id) : null;
}

// ---------- Outbox processing ----------
async function claimRows(ids, limit) {
  // Reset rows stuck in 'processing' from a crashed invocation
  await sbUpdate(
    "sharepoint_sync",
    `status=eq.processing&attempted_at=lt.${new Date(Date.now() - STALE_PROCESSING_MINUTES * 60000).toISOString()}`,
    { status: "pending" }
  );

  const candidates = ids
    ? await sb(`sharepoint_sync?select=*&id=in.(${ids.join(",")})&status=in.(pending)&order=created_at.asc`)
    : await sb(`sharepoint_sync?select=*&status=in.(pending)&order=created_at.asc&limit=${limit}`);

  if (!candidates || !candidates.length) return [];

  const claimed = await sbUpdate(
    "sharepoint_sync",
    `id=in.(${candidates.map((r) => r.id).join(",")})&status=in.(pending)`,
    { status: "processing", attempted_at: new Date().toISOString() },
    true
  );
  return claimed || [];
}

async function loadAssets(assetIds) {
  if (!assetIds.length) return new Map();
  const rows = await sb(`assets?select=id,item_id,graph_item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra&id=in.(${assetIds.join(",")})`);
  return new Map((rows || []).map((a) => [a.id, a]));
}

async function markDone(row) {
  await sbUpdate("sharepoint_sync", `id=eq.${row.id}`, {
    status: "done",
    processed_at: new Date().toISOString(),
    last_error: null,
  });
}

async function markFailed(row, message) {
  const attempts = (row.attempts || 0) + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await sbUpdate("sharepoint_sync", `id=eq.${row.id}`, {
    status: giveUp ? "failed" : "pending",
    attempts,
    last_error: String(message).slice(0, 500),
  });
  return giveUp;
}

async function setGraphItemId(assetId, gid) {
  await sbUpdate("assets", `id=eq.${assetId}`, { graph_item_id: gid });
}

async function processRow(row, assetsById, token) {
  const asset = assetsById.get(row.asset_id);
  const gid = (asset && asset.graph_item_id) || row.graph_item_id || null;

  if (row.op === "insert" || row.op === "update") {
    if (!asset) {
      // Asset row vanished (e.g. deleted before its insert synced).
      if (gid) {
        try { await graph("DELETE", itemsUrl() + "/" + gid, undefined, token); }
        catch (e) { if (e.status !== 404) throw e; } // already gone = desired end state
      }
      await markDone(row);
      return { id: row.id, op: row.op, result: "closed-no-asset" };
    }
    if (!gid) {
      const orphan = await findItemBySupabaseId(asset.id, token);
      if (orphan) {
        await setGraphItemId(asset.id, orphan);
        await markDone(row);
        return { id: row.id, op: "create", result: "adopted:" + orphan };
      }
      const created = await graph("POST", itemsUrl(), { fields: buildSpFields(asset, true) }, token);
      await setGraphItemId(asset.id, created.id);
      await markDone(row);
      return { id: row.id, op: "create", result: created.id };
    }
    if (row.op === "insert") {
      await markDone(row); // already mirrored - idempotent recovery
      return { id: row.id, op: "insert", result: "already-synced" };
    }
    await graph("PATCH", `${itemsUrl()}/${gid}`, { fields: buildSpFields(asset, false) }, token);
    await markDone(row);
    return { id: row.id, op: "update", result: gid };
  }

  if (row.op === "delete") {
    if (gid) {
      try {
        await graph("DELETE", itemsUrl() + "/" + gid, undefined, token);
      } catch (e) {
        // Already gone (double-delete or manual removal in SharePoint) =
        // desired end state; treat as success so the row completes.
        if (e.status !== 404) throw e;
      }
    }
    await markDone(row);
    return { id: row.id, op: "delete", result: gid ? "deleted" : "nothing-in-sp" };
  }

  await markFailed(row, "unknown op: " + row.op);
  return { id: row.id, op: row.op, error: "unknown op" };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const crypto = require("crypto");
  const key = String(req.headers["x-sync-key"] || "");
  const expected = process.env.SYNC_ACCESS_KEY || "";
  // Constant-time comparison (hash both sides so lengths never leak).
  const keyOk =
    expected.length > 0 &&
    crypto.timingSafeEqual(
      crypto.createHash("sha256").update(key).digest(),
      crypto.createHash("sha256").update(expected).digest()
    );
  if (!keyOk) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !CLIENT_SECRET) {
    res.status(500).json({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CLIENT_SECRET env vars" });
    return;
  }
  let body = {};
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; } catch (e) { /* default */ }

  try {
    const token = await getToken();
    await resolveIds(token);

    const claimed = await claimRows(Array.isArray(body.ids) ? body.ids : null, BATCH_LIMIT);
    if (!claimed.length) {
      res.status(200).json({ drained: 0, results: [] });
      return;
    }

    const assetsById = await loadAssets(claimed.map((r) => r.asset_id).filter(Boolean));
    const results = [];
    let ok = 0;
    let failed = 0;

    for (const row of claimed) {
      try {
        const r = await processRow(row, assetsById, token);
        results.push(r);
        ok++;
      } catch (e) {
        const gaveUp = await markFailed(row, e.message || String(e));
        results.push({ id: row.id, op: row.op, error: e.message || String(e), gaveUp });
        failed++;
      }
    }

    console.log("[sync] drained", ok, "ok,", failed, "failed");
    res.status(200).json({ drained: ok + failed, ok, failed, results });
  } catch (e) {
    // Log full detail server-side; never echo internal error text (can embed
    // Graph/Supabase responses) to the caller, even though it must authenticate.
    console.error("[sync] fatal:", e);
    res.status(500).json({ error: "Internal sync error" });
  }
};

module.exports.maxDuration = 15;
