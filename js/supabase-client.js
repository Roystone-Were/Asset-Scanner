// Shared Supabase adapter for Xana asset apps.
// Exposes window.XanaSupabase with an API shaped like the old Graph helpers
// ({id, fields:{Title, SerialNumber, ...}}) so app code changes stay minimal.
// Public values only (URL + publishable key) - safe for browsers.
(function () {
  "use strict";

  const SUPABASE_URL = "https://irqrnyixizzorvfmtvag.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_cS0GIdneT3Xccuyt0AiHWw_XBuzeBA_";
  const ADMIN_EMAIL = "it@xanalife.com";

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
    EstimatePending: "estimate_pending",
    WarrantyMonths: "warranty_months",
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

  // Throw-friendly wrapper that preserves the PostgREST error code (e.g.
  // 23505 unique violation, 42501 RLS, 22P02 bad enum) on err.code so
  // callers can tell permanent rejections from transient failures.
  function sbError(error) {
    const e = new Error("Supabase " + ((error && error.message) || "request failed"));
    if (error && error.code) e.code = String(error.code);
    return e;
  }

  // admin OR super_admin - mirrors the SQL is_admin() in 0016_super_admin.sql.
  function isAdminRole(roles) {
    const r = roles || [];
    return r.includes("admin") || r.includes("super_admin");
  }

  function fieldsToRow(fields) {
    const row = {};
    const extraPatch = {};
    for (const key of Object.keys(fields || {})) {
      if (key === "_softDelete") { row.deleted_at = new Date().toISOString(); continue; }
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
  // Useful-life defaults by type. Types absent here inherit "Other" (3 yrs).
  const USEFUL_LIFE_BY_TYPE = {
    Laptop: 3, Desktop: 4, Tower: 4, CPU: 4, Monitor: 5, Server: 5,
    Printer: 4, Scanner: 4, Tablet: 3, Phone: 3,
    POS: 5, "Cash Drawer": 8, Scale: 8,
    "Speaker/Mic": 5, Router: 5, Switch: 5, UNVR: 5, Camera: 5,
    Keyboard: 3, Mouse: 2, Headset: 3,
    Other: 3, TV: 5,
  };

  // Useful life per type, admin-editable in /admin -> Lists (app_choices
  // .useful_life, migration 0027). Loaded once per page load; a type with no
  // value set falls back to USEFUL_LIFE_BY_TYPE below, so this can be empty
  // and everything still behaves exactly as before.
  let _lifeByChoice = null;
  async function loadUsefulLives() {
    if (_lifeByChoice) return _lifeByChoice;
    const map = {};
    try {
      const { data, error } = await client()
        .from("app_choices")
        .select("value,useful_life")
        .eq("category", "asset_type");
      if (!error) {
        for (const r of data || []) {
          const n = parseFloat(r.useful_life);
          if (n > 0) map[r.value] = n;
        }
      }
    } catch (e) { /* offline or column missing - the JS map still covers it */ }
    _lifeByChoice = map;
    return map;
  }

  function enrichAsset(row) {
    const extra = row.extra || {};
    const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
    const typeRaw = str(row.asset_type);
    const configured = _lifeByChoice && _lifeByChoice[typeRaw];
    // keep any known type verbatim (incl. admin-added types); unknown → Other
    const type = typeRaw && (configured || USEFUL_LIFE_BY_TYPE[typeRaw]) ? typeRaw : "Other";
    let price = extra.purchase_price === null || extra.purchase_price === undefined || extra.purchase_price === ""
      ? NaN
      : parseFloat(String(extra.purchase_price).replace(/[^0-9.-]/g, ""));
    if (isNaN(price)) price = 0;
    // precedence: this asset's own override > the admin-set life for its type
    // > the built-in map > 3 years
    const ulRaw = extra.useful_life === undefined ? null : parseFloat(extra.useful_life);
    const usefulLife = ulRaw && ulRaw > 0 ? ulRaw : configured || USEFUL_LIFE_BY_TYPE[type] || 3;
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
      // "0000" is a deliberate placeholder ("serial to be added later"),
      // not a real serial — normalize it away so duplicate checks,
      // health stats and deep-links don't treat it as an identity.
      serial: (() => { const s = str(row.serial); return s === "0000" ? "" : s; })(),
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
      estimatePending: extra.estimate_pending === true || extra.estimate_pending === "true",
      imageUrl: str(extra.image_url),

      warrantyMonths: (() => {
        const w = extra.warranty_months;
        if (w === null || w === undefined || w === "") return null;
        const n = parseFloat(w);
        return isNaN(n) || n <= 0 ? null : n;
      })(),
    };
  }

  async function listAssetsDetailed() {
    // the life map must be in place before enrichAsset runs; both /assets and
    // /dashboard come through here, so one load covers the whole app
    const [{ data, error }] = await Promise.all([
      client()
        .from("assets")
        .select("item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra")
        .is("deleted_at", null),
      loadUsefulLives(),
    ]);
    if (error) throw sbError(error)
    return (data || []).map(enrichAsset);
  }

  // Recycle bin: soft-deleted assets only
  async function listDeletedAssets() {
    const [{ data, error }] = await Promise.all([
      client()
        .from("assets")
        .select("item_id,title,asset_tag,asset_type,model,serial,employee,status,location,extra,deleted_at")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false }),
      loadUsefulLives(),
    ]);
    if (error) throw sbError(error)
    return (data || []).map((row) => ({
      ...enrichAsset(row),
      deletedAt: row.deleted_at,
    }));
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
    const pending = it.filter((i) => i.estimatePending);

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
        confirmedBookValue: Math.round(sum(it.filter((i) => !i.estimatePending), (i) => i.bookValue) * 100) / 100,
        estimatePendingCount: pending.length,
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
      items: it,
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
      .is("deleted_at", null)
      .order("item_id", { ascending: true });
    if (error) throw sbError(error)
    return (data || []).map((row) => ({
      id: String(row.item_id),
      fields: rowToFields(row),
    }));
  }

  async function nextItemId() {
    // item_id is TEXT: client-side ORDER BY sorts alphabetically ('99' > '121').
    // Ask the database for numeric max + 1 instead.
    const { data, error } = await client().rpc("next_asset_item_id");
    if (error) throw sbError(error)
    return String(data);
  }

  async function insertAsset(fields) {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = fieldsToRow(fields);
      row.item_id = await nextItemId();
      const { data, error } = await client().from("assets").insert(row).select("item_id").single();
      if (!error) return { id: String(data.item_id) };
      lastErr = error;
      if (error.code !== "23505") break;
      // unique violation: someone else took that id — small backoff, recompute
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
    }
    const err = lastErr || new Error("insert failed");
    throw sbError(err);
  }

  async function updateAsset(id, patch) {
    const row = fieldsToRow(patch);
    // extra is a jsonb blob: merge server-side so a partial patch (e.g. only
    // Condition) doesn't wipe purchase_date and the other extras.
    if (row.extra && Object.keys(row.extra).length) {
      const { error: rpcErr } = await client().rpc("asset_extra_merge", {
        p_item_id: String(id),
        p_patch: row.extra,
      });
      if (rpcErr) throw sbError(rpcErr)
      delete row.extra;
    }
    if (!Object.keys(row).length) return { ok: true };
    const { error } = await client().from("assets").update(row).eq("item_id", String(id));
    if (error) throw sbError(error)
    return { ok: true };
  }

  // Soft delete — moves to recycle bin (restorable). The outbox/audit
  // triggers fire on UPDATE too, so the mirror sees it like any change.
  async function deleteAsset(id) {
    return updateAsset(id, { _softDelete: true });
  }

  async function restoreAsset(id) {
    const { error } = await client().from("assets").update({ deleted_at: null }).eq("item_id", String(id));
    if (error) throw sbError(error)
    return { ok: true };
  }

  async function purgeAsset(id) {
    const { error } = await client().from("assets").delete().eq("item_id", String(id));
    if (error) throw sbError(error)
    return { ok: true };
  }

  // ---------- Auth (email OTP) ----------
  async function sendOtp(email, opts) {
    // Invite-only: never mint accounts from the public sign-in form.
    // Optional emailRedirectTo keeps the ?next= intent through magic links.
    const options = { shouldCreateUser: false };
    if (opts && opts.emailRedirectTo) options.emailRedirectTo = opts.emailRedirectTo;
    const { error } = await client().auth.signInWithOtp({
      email: String(email || "").trim(),
      options,
    });
    if (error) throw error;
    return { sent: true };
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
    // One retry: a transient network blip must not bounce a signed-in user
    // to /login. Persistent failure still degrades to "no roles".
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data, error } = await client().from("user_roles").select("role");
        if (!error) return (data || []).map((r) => r.role);
      } catch (e) { /* retry then give up */ }
      if (attempt === 0) await new Promise((res) => setTimeout(res, 400));
    }
    return [];
  }

  async function landingFor() {
    const roles = await myRoles();
    if (isAdminRole(roles)) return "/dashboard";
    if (roles.includes("scanner")) return "/scan";
    if (roles.includes("asset_viewer")) return "/assets";
    if (roles.includes("dashboard_viewer")) return "/dashboard";
    return "";
  }

  // Hide nav links the current user holds no role for.
  function applyRoleNav(roles) {
    const r = roles || [];
    const allow = {
      "/scan": r.includes("scanner") || isAdminRole(r),
      "/assets": r.includes("asset_viewer") || isAdminRole(r),
      "/dashboard": r.includes("dashboard_viewer") || isAdminRole(r),
      "/admin": isAdminRole(r),
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
  // ---------- IT documents (Supabase Storage, admin-only write) ----------
  // Flat bucket, no per-item subfolders (unlike asset-images) -- these are
  // general reference forms, not tied to one asset. Write is gated by
  // is_admin() at the RLS level (0025_it_documents_storage.sql); read is
  // public same as asset-images (ADR-002 convention).
  async function listItDocuments() {
    const { data, error } = await client().storage.from("it-documents").list("", { sortBy: { column: "created_at", order: "desc" } });
    if (error) throw new Error(error.message);
    return (data || []).filter((f) => f.id).map((f) => ({
      name: f.name,
      size: f.metadata && f.metadata.size,
      updatedAt: f.updated_at,
      publicUrl: client().storage.from("it-documents").getPublicUrl(f.name).data.publicUrl,
    }));
  }
  async function uploadItDocument(file) {
    const path = Date.now() + "_" + file.name.replace(/[^\w.\-]+/g, "_");
    const up = await client().storage.from("it-documents").upload(path, file, { contentType: file.type || "application/octet-stream" });
    if (up.error) throw new Error(up.error.message);
    return path;
  }
  async function deleteItDocument(path) {
    const del = await client().storage.from("it-documents").remove([path]);
    if (del.error) throw new Error(del.error.message);
  }

  // Persist an image URL onto the asset's extra jsonb so the detail card can
  // show it without re-uploading. Server side: asset_extra_merge keeps the
  // rest of the blob untouched (migration 0010).
  async function attachAssetImage(itemId, url) {
    if (!itemId || !url) return { ok: false };
    const { error } = await client().rpc("asset_extra_merge", {
      p_item_id: String(itemId),
      p_patch: { image_url: String(url) },
    });
    if (error) throw sbError(error);
    return { ok: true };
  }


  // ---------- Asset events (issues / repairs / transfers / maintenance) ----------
  async function listAssetEvents(itemId) {
    const { data, error } = await client()
      .from("asset_events")
      .select("id,event_type,event_date,description,cost,resolved,created_by,created_at")
      .eq("item_id", String(itemId))
      .order("event_date", { ascending: false })
      .limit(100);
    if (error) throw sbError(error)
    return data || [];
  }

  async function addAssetEvent(itemId, { type, description, cost, resolved }) {
    const email = await currentUserEmail();
    const { data, error } = await client()
      .from("asset_events")
      .insert({
        item_id: String(itemId),
        event_type: type,
        description: String(description || "").trim(),
        cost: cost === "" || cost === null || cost === undefined ? null : Number(cost),
        // only an issue can stay open; everything else is a completed happening
        resolved: type === "issue" ? resolved === true : true,
        created_by: email || null,
      })
      .select("id")
      .single();
    if (error) throw sbError(error)
    return { id: data.id };
  }

  // Close an open issue (RLS: scanner/admin, same as logging one)
  async function resolveAssetEvent(eventId) {
    const { error } = await client()
      .from("asset_events")
      .update({ resolved: true })
      .eq("id", eventId);
    if (error) throw sbError(error)
    return true;
  }

  async function setEventResolved(eventId, resolved) {
    const { error } = await client()
      .from("asset_events")
      .update({ resolved: !!resolved })
      .eq("id", eventId);
    if (error) throw sbError(error)
    return { ok: true };
  }

  // Auto-transfer log: called whenever employee/location changes on an asset.
  async function logTransfer(itemId, what, fromVal, toVal) {
    try {
      await addAssetEvent(itemId, {
        type: "transfer",
        description: what + ": " + (fromVal || "(none)") + " → " + (toVal || "(none)"),
      });
    } catch (e) { /* transfer logging must never block the edit itself */ }
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
    restoreAsset,
    purgeAsset,
    listDeletedAssets,
    sendOtp,
    signInWithPassword,
    getSession,
    myRoles,
    isAdminRole,
    landingFor,
    applyRoleNav,
    currentUserEmail,
    popAuthNotice,
    signOut,
    mustChangePassword,
    completePasswordChange,
    uploadAssetImage,
    attachAssetImage,
    listItDocuments,
    uploadItDocument,
    deleteItDocument,
    listAssetEvents,
    addAssetEvent,
    resolveAssetEvent,
    setEventResolved,
    logTransfer,
  };
})();
