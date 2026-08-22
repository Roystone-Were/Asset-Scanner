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

  function isAdmin(email) {
    return String(email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase();
  }

  window.XanaSupabase = {
    ADMIN_EMAIL,
    FIELD_TO_COL,
    COL_TO_FIELD,
    client,
    fieldsToRow,
    rowToFields,
    listAssets,
    insertAsset,
    updateAsset,
    deleteAsset,
    sendOtp,
    verifyOtp,
    getSession,
    currentUserEmail,
    signOut,
    isAdmin,
  };
})();
