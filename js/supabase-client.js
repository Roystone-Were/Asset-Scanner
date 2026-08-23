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
        detectSessionInUrl: true,
      },
    });
  }

  // If a user clicks an emailed link and auth FAILS (expired/used token),
  // Supabase lands back with #error=... - surface a friendly hint and clean
  // the URL. Successful-link fragments (#access_token=...) are left alone
  // for supabase-js to consume into a session.
  function sanitizeAuthHash() {
    try {
      if (!location.hash || location.hash.indexOf("#") !== 0) return;
      const params = new URLSearchParams(location.hash.slice(1));
      const err = params.get("error_description") || params.get("error");
      if (!err) return;
      history.replaceState(null, "", location.pathname + location.search);
      const msg = err.indexOf("expired") !== -1 || err.indexOf("invalid") !== -1
        ? "That email link expired or was already used - go to /login and request a fresh code."
        : err;
      sessionStorage.setItem("xana_auth_notice", msg);
      console.warn("[auth]", msg);
    } catch (e) { /* never block boot */ }
  }
  sanitizeAuthHash();

  function popAuthNotice() {
    try {
      const n = sessionStorage.getItem("xana_auth_notice");
      if (n) sessionStorage.removeItem("xana_auth_notice");
      return n;
    } catch (e) { return null; }
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

  // ---------- Portfolio summary ----------
  // Port of api/summary.js computeSummary - runs on enriched items from
  // listAssetsDetailed() so the dashboard needs no server round-trip.
  function computeSummary(items) {
    const it = items || [];
    const sum = (arr, f) => arr.reduce((s, i) => s + f(i), 0);
    const purchaseValue = Math.round(sum(it, (i) => i.purchasePrice) * 100) / 100;
    const bookValue = Math.round(sum(it, (i) => i.bookValue) * 100) / 100;
    const fullyDepreciated = it.filter((i) => i.depStatus === "Fully depreciated").length;

    const expensedThisYear = it.filter((i) => i.depStatus === "In progress" && i.usefulLife > 0 && i.purchasePrice > 0)
      .reduce((s, i) => s + i.purchasePrice / i.usefulLife, 0);

    const byStatus = {}, byType = {}, byLocation = {}, byDepartment = {};
    for (const i of it) {
      byStatus[i.status || "—"] = (byStatus[i.status || "—"] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      byLocation[i.location || "Unassigned"] = (byLocation[i.location || "Unassigned"] || 0) + 1;
      byDepartment[i.department && i.department !== "" ? i.department : "—"] =
        (byDepartment[i.department && i.department !== "" ? i.department : "—"] || 0) + 1;
    }

    const replacementDue = it.filter((i) =>
      i.purchasePrice > 0 &&
      (i.depStatus === "Fully depreciated" ||
        (i.ageYears !== null && i.usefulLife > 0 && i.ageYears + 1 >= i.usefulLife)));
    const idleStock = it.filter((i) => i.status === "Available" || (!i.employee && i.status !== "Retired" && i.status !== "Lost"));
    const lostAssets = it.filter((i) => i.status === "Lost");
    const annualDep = it.reduce((s, i) => {
      if (!(i.purchasePrice > 0) || !(i.usefulLife > 0)) return s;
      if (i.ageYears !== null && i.ageYears >= i.usefulLife) return s;
      return s + i.purchasePrice / i.usefulLife;
    }, 0);

    const unverified = it.filter((i) => {
      if (!i.lastVerified) return true;
      const d = new Date(i.lastVerified);
      return isNaN(d.getTime()) || Date.now() - d.getTime() > 90 * 86400000;
    }).length;

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        total: it.length,
        purchaseValue,
        bookValue,
        fullyDepreciated,
        expensedThisYear: Math.round(expensedThisYear * 100) / 100,
        missingPurchase: it.filter((i) => !i.purchaseDate).length,
      },
      finance: {
        annualDepreciation: Math.round(annualDep * 100) / 100,
        replacementDue12mo: replacementDue.length,
        replacementCost12mo: Math.round(sum(replacementDue, (i) => i.purchasePrice) * 100) / 100,
        idleAssets: idleStock.length,
        idleBookValue: Math.round(sum(idleStock, (i) => i.bookValue) * 100) / 100,
        lostAssets: lostAssets.length,
        lostCost: Math.round(sum(lostAssets, (i) => i.purchasePrice) * 100) / 100,
      },
      byStatus, byType, byLocation, byDepartment,
      dataHealth: {
        missingSerial: it.filter((i) => !i.serial).length,
        missingTag: it.filter((i) => !i.tag).length,
        missingPurchase: it.filter((i) => !i.purchaseDate).length,
        unverified,
      },
      items: it.slice(0, 500),
    };
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
    // extra is a jsonb blob: merge server-side so a partial patch (e.g. only
    // Condition) doesn't wipe purchase_date and the other extras.
    const extraKeys = Object.keys(row.extra || {});
    if (extraKeys.length && !("item_id" in row)) {
      const merged = { ...row };
      delete merged.extra;
      const payload = {};
      for (const k of extraKeys) payload["extra." + k] = row.extra[k];
      const { error } = await client().from("assets").update(payload).eq("item_id", String(id));
      if (error) throw new Error("Supabase " + error.message);
      // top-level columns (if any in this patch)
      if (Object.keys(merged).length) {
        const { error: e2 } = await client().from("assets").update(merged).eq("item_id", String(id));
        if (e2) throw new Error("Supabase " + e2.message);
      }
      return { ok: true };
    }
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
    const { error } = await client().auth.signInWithOtp({
      email: String(email || "").trim(),
      options: { shouldCreateUser: false },
    });
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

  async function signInWithPassword(email, password) {
    const { data, error } = await client().auth.signInWithPassword({
      email: String(email || "").trim(),
      password: String(password || ""),
    });
    if (error) throw new Error(error.message);
    return { user: data.user };
  }

  async function getSession() {
    const { data } = await client().auth.getSession();
    return data && data.session ? data.session : null;
  }

  // ---------- Roles ----------
  async function myRoles() {
    try {
      const { data, error } = await client().from("user_roles").select("role");
      if (error) return [];
      return (data || []).map((r) => r.role);
    } catch (e) {
      return [];
    }
  }

  async function landingFor() {
    const roles = await myRoles();
    if (roles.includes("admin")) return "/dashboard";
    if (roles.includes("scanner")) return "/scan";
    if (roles.includes("asset_viewer")) return "/assets";
    if (roles.includes("dashboard_viewer")) return "/dashboard";
    return "";
  }

  // Hide nav links the current user holds no role for.
  function applyRoleNav(roles) {
    const r = roles || [];
    const allow = {
      "/scan": r.includes("scanner") || r.includes("admin"),
      "/assets": r.includes("asset_viewer") || r.includes("admin"),
      "/dashboard": r.includes("dashboard_viewer") || r.includes("admin"),
      "/admin": r.includes("admin"),
    };
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = (a.getAttribute("href") || "").split(/[?#]/)[0];
      if (!(href in allow)) return;
      if (!allow[href]) a.style.display = "none";
    });
  }

  async function currentUserEmail() {
    const s = await getSession();
    return s && s.user ? String(s.user.email || "").toLowerCase() : "";
  }

  async function signOut() {
    await client().auth.signOut();
  }

  // ---------- Forced password change (manual-password onboarding) ----------
  async function mustChangePassword() {
    const s = await getSession();
    if (!s || !s.user) return false;
    try {
      const { data } = await client()
        .from("profiles")
        .select("must_change_password")
        .eq("id", s.user.id)
        .single();
      return !!(data && data.must_change_password);
    } catch (e) {
      return false;
    }
  }

  async function completePasswordChange(newPassword) {
    const { error } = await client().auth.updateUser({ password: newPassword });
    if (error) throw error;
    const s = await getSession();
    if (!s || !s.user) throw new Error("Not signed in");
    const { error: perr } = await client()
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", s.user.id);
    if (perr) throw perr;
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
    computeSummary,
    insertAsset,
    updateAsset,
    deleteAsset,
    sendOtp,
    verifyOtp,
    signInWithPassword,
    getSession,
    myRoles,
    landingFor,
    applyRoleNav,
    currentUserEmail,
    popAuthNotice,
    signOut,
    isAdmin,
    mustChangePassword,
    completePasswordChange,
    uploadAssetImage,
  };
})();
