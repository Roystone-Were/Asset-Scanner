// Vercel serverless function — SharePoint sync worker
// Drains public.sharepoint_sync (outbox) into the SharePoint list via Graph.
// Called two ways:
//   1. pg_net trigger on every new outbox row  -> body { ids: ["uuid"] }
//   2. pg_cron retry sweep every 5 minutes     -> body {} (drains everything pending)
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TENANT, CLIENT_ID,
//           CLIENT_SECRET, SITE_URL, LIST_NAME, SYNC_ACCESS_KEY
// Optional: SITE_ID, LIST_ID, SYNC_MAX_ATTEMPTS (default 5), SYNC_BATCH_LIMIT (default 10)

const TENANT    = process.env.TENANT    || "refrontiergroup.onmicrosoft.com";
const CLIENT_ID = process.env.CLIENT_ID || "7caa51af-9f32-42d8-8264-da5b97c2f8eb";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const SITE_URL   = process.env.SITE_URL   || "https://refrontiergroup.sharepoint.com/sites/xanalifeTechData";
const LIST_NAME  = process.env.LIST_NAME  || "Xana Asset Inventory";
const SITE_ID_OVERRIDE = process.env.SITE_ID || "";
const LIST_ID_OVERRIDE = process.env.LIST_ID || "";
const MAX_ATTEMPTS = parseInt(process.env.SYNC_MAX_ATTEMPTS || "5", 10);
// ~3 Graph round trips per row; 10 rows stays inside the function's 30 s limit.
const BATCH_LIMIT  = parseInt(process.env.SYNC_BATCH_LIMIT || "10", 10);

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
// The query is non-indexed, so Graph only honours it "may fail randomly" —
// return every match and let the caller collapse duplicates.
async function findItemsBySupabaseId(assetId, token) {
  const filter = encodeURIComponent(`fields/SupabaseId eq '${assetId}'`);
  const data = await graph("GET", `${itemsUrl()}?$filter=${filter}&$select=id`, undefined, token, {
    Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
  });
  return (data.value || []).map((it) => String(it.id));
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
  const rows = await sb(`assets?select=id,item_id,graph_item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra,deleted_at&id=in.(${assetIds.join(",")})`);
  return new Map((rows || []).map((a) => [a.id, a]));
}

async function markDone(row, note) {
  await sbUpdate("sharepoint_sync", `id=eq.${row.id}`, {
    status: "done",
    processed_at: new Date().toISOString(),
    // `note` records self-healing work (recovered 404, duplicate removed) for
    // later diagnosis; the admin UI only lists pending/failed rows.
    last_error: note || null,
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

// Delete the mirror item(s) for an asset. `gid` is the recorded SharePoint id;
// when it is missing we fall back to the SupabaseId fingerprint, so a create
// that committed but lost its write-back does not leave an orphan behind.
// A 404 is the desired end state (someone removed the item by hand) and counts
// as "already absent" rather than an error.
async function deleteMirrorItems(assetId, gid, token) {
  const ids = gid ? [String(gid)] : assetId ? await findItemsBySupabaseId(assetId, token) : [];
  let removed = 0;
  let missing = 0;
  for (const id of ids) {
    try {
      await graph("DELETE", itemsUrl() + "/" + id, undefined, token);
      removed++;
    } catch (e) {
      if (e.status !== 404) throw e;
      missing++;
    }
  }
  return { ids, removed, missing };
}

// Graph's non-indexed query is only best-effort, so the same SupabaseId can be
// mirrored twice after a lost create response. Keep the recorded id (else the
// lowest) and delete the rest, logging what went.
async function collapseDuplicates(ids, keepId, token) {
  const sorted = ids.slice().sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const keep = keepId && ids.includes(keepId) ? keepId : sorted[0];
  for (const id of ids) {
    if (id === keep) continue;
    await graph("DELETE", itemsUrl() + "/" + id, undefined, token);
    console.log(`[sync] removed duplicate mirror item ${id} (kept ${keep})`);
  }
  return keep;
}

async function processRow(row, assetsById, token) {
  const asset = assetsById.get(row.asset_id);
  const gid = (asset && asset.graph_item_id) || row.graph_item_id || null;
  // 0041: delete rows snapshot the identity into payload, because the FK's
  // ON DELETE SET NULL has already detached asset_id by the time we drain the
  // row (delete rows written before 0041 have no payload).
  const linkedId = row.asset_id || (row.payload && row.payload.asset_id) || null;

  if (row.op === "insert" || row.op === "update") {
    if (!asset) {
      // Asset row vanished (e.g. deleted before its insert synced). Anything
      // mirrored for it is an orphan now, so remove it rather than leaving it.
      const gone = await deleteMirrorItems(linkedId, gid, token);
      await markDone(row, gone.missing ? `mirror item ${gone.ids.join(",")} already absent` : null);
      return { id: row.id, op: row.op, result: gone.removed ? "closed-removed:" + gone.removed : "closed-no-asset" };
    }
    if (asset.deleted_at) {
      // 0019: a binned asset is deleted in the mirror until it is restored.
      // graph_item_id is deliberately kept, so the restore's PATCH misses
      // (404) and the create path re-mirrors it.
      const gone = await deleteMirrorItems(asset.id, gid, token);
      await markDone(row, gone.missing ? "mirror item already absent (binned)" : null);
      return { id: row.id, op: row.op, result: gone.removed ? "binned-deleted" : "binned-none" };
    }
    if (!gid) {
      const found = await findItemsBySupabaseId(asset.id, token);
      if (found.length) {
        const keep = await collapseDuplicates(found, null, token);
        await setGraphItemId(asset.id, keep);
        await markDone(row, found.length > 1 ? `collapsed ${found.length} mirror items to ${keep}` : null);
        return { id: row.id, op: "create", result: "adopted:" + keep };
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
    try {
      await graph("PATCH", `${itemsUrl()}/${gid}`, { fields: buildSpFields(asset, false) }, token);
    } catch (e) {
      if (e.status !== 404) throw e;
      // The mirror item is gone (removed by hand, or by this asset's own
      // bin->restore cycle). The recorded id is poison: forget it and create a
      // fresh item now, instead of retrying a dead PATCH until the row burns
      // through MAX_ATTEMPTS.
      console.log(`[sync] mirror item ${gid} missing (404) for asset ${asset.item_id}; re-creating`);
      await setGraphItemId(asset.id, null);
      const created = await graph("POST", itemsUrl(), { fields: buildSpFields(asset, true) }, token);
      await setGraphItemId(asset.id, created.id);
      await markDone(row, `graph item ${gid} was missing (404); re-created as ${created.id}`);
      return { id: row.id, op: row.op, result: "recreated:" + created.id };
    }
    await markDone(row);
    return { id: row.id, op: row.op, result: gid };
  }

  if (row.op === "delete") {
    // Identity comes from the payload snapshot (0041) when asset_id was
    // detached; a mirror item whose SupabaseId is no longer any asset is
    // exactly what scripts/reconcile-mirror.mjs reports.
    const key = (row.payload && row.payload.item_id) || null;
    const gone = await deleteMirrorItems(linkedId, gid, token);
    await markDone(
      row,
      gone.ids.length
        ? gone.missing
          ? `mirror item ${gone.ids.join(",")} already absent`
          : null
        : `nothing to delete for ${key || "unknown asset"}: no graph_item_id and no asset link on the row`
    );
    return { id: row.id, op: "delete", result: gone.removed ? "deleted:" + gone.removed : "nothing-in-sp" };
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

module.exports.maxDuration = 30;
