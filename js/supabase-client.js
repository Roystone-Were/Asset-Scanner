// Shared Supabase adapter for Xana asset apps.
// Exposes window.XanaSupabase with an API shaped like the old Graph helpers
// ({id, fields:{Title, SerialNumber, ...}}) so app code changes stay minimal.
// Public values only (URL + publishable key) - safe for browsers.
(function () {
  "use strict";

  const SUPABASE_URL = "https://irqrnyixizzorvfmtvag.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_cS0GIdneT3Xccuyt0AiHWw_XBuzeBA_";
  const ADMIN_EMAIL = "roystone@xanalife.com";

  // Supabase column <-> SharePoint field internal name
  const FIELD_TO_COL = {
    Title: "title",
    Asset: "asset_type",
    Model: "model",
    SerialNumber: "serial",
    EmployeeName: "employee",
    Status: "status",
    Location: "location",
    LastVerified: "_lv",
    LastVerifiedBy: "_lvby",
  };
  const COL_TO_FIELD = {
    title: "Title",
    asset_type: "Asset",
    model: "Model",
    serial: "SerialNumber",
    employee: "EmployeeName",
    status: "Status",
    location: "Location",
  };

  // SharePoint field names used by the add/edit forms that live in extra
  const FORM_EXTRA_MAP = {
    Department: "department",
    EmployeeNumber: "employee_number",
    PhoneNumber: "phone_number",
    Condition: "condition",
    RAM: "ram",
    Region: "region",
    PurchaseDate: "purchase_date",
    PurchasePrice: "purchase_price",
    DateIssued: "date_issued",
  };

  function createClient() {
    if (!window.supabase) {
      throw new Error("supabase-js not loaded - include the CDN script before supabase-client.js");
    }
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }

  let _client = null;
  function client() {
    if (!_client) _client = createClient();
    return _client;
  }

  function fieldsToRow(fields) {
    const row = {};
    const extraPatch = {};
    for (const key of Object.keys(fields || {})) {
      const col = FIELD_TO_COL[key];
      const val = fields[key];
      if (key === "LastVerified") extraPatch.last_verified = val === null ? null : String(val);
      else if (key === "LastVerifiedBy") extraPatch.last_verified_by = val === null ? null : String(val);
      else if (FORM_EXTRA_MAP[key]) extraPatch[FORM_EXTRA_MAP[key]] = val;
      else if (col) {
        if (key === "Title") {
          row.title = val;
          row.asset_tag = val;
        } else row[col] = val;
      }
    }
    if (Object.keys(extraPatch).length) {
      row.extra = extraPatch;
    }
    return row;
  }

  // ---------- Depreciation view model ----------
  // Ported from api/summary.js so the assets app computes book values
  // client-side straight from Supabase rows.
  const USEFUL_LIFE_BY_TYPE = {
    Laptop: 3, Desktop: 4, Tower: 4, Monitor: 5, Server: 5,
    Printer: 4, Tablet: 3, Phone: 3, Other: 3,
  };

  function enrichAsset(row) {
    const extra = row.extra || {};
    const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
    const typeRaw = str(row.asset_type);
    const type = USEFUL_LIFE_BY_TYPE[typeRaw] ? typeRaw : "Other";
    let price = extra.purchase_price === null || extra.purchase_price === undefined || extra.purchase_price === ""
      ? NaN
      : parseFloat(String(extra.purchase_price).replace(/[^0-9.-]/g, ""));
    if (isNaN(price)) price = 0;
    const ulRaw = extra.useful_life === undefined ? null : parseFloat(extra.useful_life);
    const usefulLife = ulRaw && ulRaw > 0 ? ulRaw : USEFUL_LIFE_BY_TYPE[type] || 3;
    let age = null;
    if (extra.purchase_date) {
      const d = new Date(extra.purchase_date);
      if (!isNaN(d.getTime())) age = Math.max(0, (Date.now() - d.getTime()) / 365.25 / 86400000);
    }
    const annualDep = usefulLife > 0 ? price / usefulLife : 0;
    const accumDep = age !== null && usefulLife > 0 ? Math.min(price, age * annualDep) : 0;
    const bookValue = Math.max(0, price - accumDep);
    const depStatus = age === null ? "No data" : age >= usefulLife ? "Fully depreciated" : "In progress";
    return {
      id: String(row.item_id),
      tag: str(row.asset_tag) || str(row.title),
      serial: str(row.serial),
      model: str(row.model),
      employee: str(row.employee),
      department: str(extra.department),
      location: str(row.location),
      status: str(row.status),
      type,
      condition: str(extra.condition),
      purchaseDate: extra.purchase_date ? String(extra.purchase_date).slice(0, 10) : "",
      purchasePrice: price,
      usefulLife,
      ageYears: age !== null ? Math.round(age * 100) / 100 : null,
      accumDep: Math.round(accumDep * 100) / 100,
      bookValue: Math.round(bookValue * 100) / 100,
      depStatus,
      lastVerified: str(extra.last_verified),
    };
  }

  async function listAssetsDetailed() {
    const { data, error } = await client()
      .from("assets")
      .select("item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra");
    if (error) throw new Error("Supabase " + error.message);
    return (data || []).map(enrichAsset);
  }

  function rowToFields(row) {
    const fields = {};
    if (!row) return fields;
    for (const [col, name] of Object.entries(COL_TO_FIELD)) {
      if (row[col] !== null && row[col] !== undefined) fields[name] = row[col];
    }
    if (row.title !== null && row.title !== undefined && fields.Title === undefined) {
      fields.Title = row.asset_tag != null ? row.asset_tag : row.title;
    }
    const extra = row.extra || {};
    if (extra.last_verified) fields.LastVerified = extra.last_verified;
    if (extra.last_verified_by) fields.LastVerifiedBy = extra.last_verified_by;
    return fields;
  }

  async function listAssets() {
    const { data, error } = await client()
      .from("assets")
      .select("item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra")
      .order("item_id", { ascending: true });
    if (error) throw new Error("Supabase " + error.message);
    return (data || []).map((row) => ({
      id: String(row.item_id),
      fields: rowToFields(row),
    }));
  }

  async function nextItemId() {
    const { data, error } = await client()
      .from("assets")
      .select("item_id")
      .order("item_id", { ascending: false })
      .limit(50);
    if (error) throw new Error("Supabase " + error.message);
    let max = 0;
    for (const r of data || []) {
      const n = parseInt(r.item_id, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return String(max + 1);
  }

  async function insertAsset(fields) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = fieldsToRow(fields);
      row.item_id = await nextItemId();
      const { data, error } = await client().from("assets").insert(row).select("item_id").single();
      if (!error) return { id: String(data.item_id) };
      lastErr = error;
      if (error.code !== "23505") break;
    }
    throw new Error("Supabase " + (lastErr ? lastErr.message : "insert failed"));
  }

  async function updateAsset(id, patch) {
    const row = fieldsToRow(patch);
    const { error } = await client().from("assets").update(row).eq("item_id", String(id));
    if (error) throw new Error("Supabase " + error.message);
    return { ok: true };
  }

  async function deleteAsset(id) {
    const { error } = await client().from("assets").delete().eq("item_id", String(id));
    if (error) throw new Error("Supabase " + error.message);
    return { ok: true };
  }

  // ---------- Auth (email OTP) ----------
  async function sendOtp(email) {
    const { error } = await client().auth.signInWithOtp({ email: String(email || "").trim() });
    if (error) throw new Error(error.message);
    return { sent: true };
  }

  async function verifyOtp(email, token) {
    const { data, error } = await client().auth.verifyOtp({
      email: String(email || "").trim(),
      token: String(token || "").trim(),
      type: "email",
    });
    if (error) throw new Error(error.message);
    return { user: data.user };
  }

  async function getSession() {
    const { data } = await client().auth.getSession();
    return data && data.session ? data.session : null;
  }

  async function currentUserEmail() {
    const s = await getSession();
    return s && s.user ? String(s.user.email || "").toLowerCase() : "";
  }

  async function signOut() {
    await client().auth.signOut();
  }

  // ---------- Asset images (Supabase Storage) ----------
  async function uploadAssetImage(itemId, dataUrl, fileName) {
    const base64 = String(dataUrl || "").split(",")[1];
    if (!base64) return null;
    const path = itemId + "/" + (fileName || "asset.jpg").replace(/[^\w.\-]+/g, "_");
    const blob = await (await fetch(dataUrl)).blob();
    const up = await client().storage.from("asset-images").upload(path, blob, {
      contentType: blob.type || "image/jpeg",
      upsert: true,
    });
    if (up.error) throw new Error(up.error.message);
    const pub = client().storage.from("asset-images").getPublicUrl(path);
    return pub && pub.data ? pub.data.publicUrl : null;
  }

  function isAdmin(email) {
    return String(email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase();
  }

  window.XanaSupabase = {
    ADMIN_EMAIL,
    FIELD_TO_COL,
    COL_TO_FIELD,
    FORM_EXTRA_MAP,
    client,
    fieldsToRow,
    rowToFields,
    enrichAsset,
    listAssets,
    listAssetsDetailed,
    insertAsset,
    updateAsset,
    deleteAsset,
    sendOtp,
    verifyOtp,
    getSession,
    currentUserEmail,
    signOut,
    isAdmin,
    uploadAssetImage,
  };
})();
