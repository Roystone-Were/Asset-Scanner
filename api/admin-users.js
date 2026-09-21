// Vercel serverless function — admin user management
// POST /api/admin-users   Authorization: Bearer <Supabase access token>
// Body: { action, ... }
//   list                          -> all users with profile + roles
//   invite {email, fullName, roles[], reactivate?}  -> create auth user + profile + roles
//   create_with_password {email, fullName, roles[], password}
//   reset_password {userId, password}
//   set_roles {userId, roles[]}   -> replace role set (one set_user_roles() call)
//   set_active {userId, active}   -> enable/disable login
//   delete_user {userId}
//   sync_health                   -> SharePoint mirror queue + per-status counts
//   requeue                       -> requeue every failed outbox row
//   retry_row {id}                -> requeue one outbox row
// Every call re-verifies the caller's JWT and admin role server-side, and every
// accepted mutation is recorded in admin_audit (service-role write; the table
// has no insert policy, precisely so the browser can't forge a row).
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// super_admin is a real role in the DB (0029/0036): leaving it out here made
// `list` return it while the grid had no box for it, so a single tick on any
// other box saved a role set that silently dropped super_admin.
const VALID_ROLES = ["scanner", "asset_viewer", "dashboard_viewer", "admin", "super_admin"];

// Best-effort throttle. Serverless instances are ephemeral and each holds its
// own Map, so this only blunts a runaway client (a checkbox saving per tick, a
// stuck retry loop) — it is not a security boundary and never was.
const RATE_LIMIT = 60;             // mutating calls ...
const RATE_WINDOW_MS = 60 * 1000;  // ... per caller, per minute
const MUTATING_ACTIONS = new Set([
  "invite", "create_with_password", "reset_password", "set_roles", "set_active",
  "delete_user", "requeue", "retry_row",
]);
const rateHits = new Map();        // caller id -> [timestamps]

function rateLimited(callerId) {
  const now = Date.now();
  const hits = (rateHits.get(callerId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) {
    rateHits.set(callerId, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(callerId, hits);
  // Evict callers that fell out of the window so a long-lived instance
  // doesn't grow the Map without bound.
  if (rateHits.size > 200) {
    for (const [id, ts] of rateHits) if (!ts.length || now - ts[ts.length - 1] > RATE_WINDOW_MS) rateHits.delete(id);
  }
  return false;
}

function serviceHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    Authorization: "Bearer " + (process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
    "Content-Type": "application/json",
  };
}

async function sb(path, options = {}) {
  const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/" + path, {
    ...options,
    headers: { ...serviceHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text()).slice(0, 250));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function authAdmin(path, options = {}) {
  const res = await fetch(process.env.SUPABASE_URL + "/auth/v1/" + path, {
    ...options,
    headers: { ...serviceHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error("Auth " + res.status + ": " + (await res.text()).slice(0, 250));
  return res.json();
}

async function callerIsAdmin(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const jwt = auth.slice(7);
  try {
    const me = await authAdmin("user", { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "", Authorization: "Bearer " + jwt } });
    if (!me || !me.id) return null;
    const prof = await sb("profiles?select=id,active&id=eq." + me.id);
    if (!prof || !prof.length || !prof[0].active) return null;
    const roles = await sb("user_roles?select=role&user_id=eq." + me.id);
    const mine = (roles || []).map((r) => r.role);
    if (!mine.includes("admin") && !mine.includes("super_admin")) return null;
    return { id: me.id, email: me.email, isSuper: mine.includes("super_admin") };
  } catch (e) {
    console.error("[admin-users] caller verify failed:", e.message);
    return null;
  }
}

// All auth users -> { id: last_sign_in_at }. Paginated same as
// findUserIdByEmail below; small team, almost always a single page.
async function authLastSeenMap() {
  const map = {};
  for (let page = 1; page <= 10; page++) {
    const data = await authAdmin("admin/users?per_page=200&page=" + page);
    const users = data.users || [];
    if (!users.length) break;
    for (const u of users) map[u.id] = u.last_sign_in_at || null;
    if (users.length < 200) break;
  }
  return map;
}

async function stitchUsers() {
  const [profiles, roles, lastSeen] = await Promise.all([
    sb("profiles?select=id,email,full_name,active,invited_by,created_at,last_seen&order=created_at.asc"),
    sb("user_roles?select=user_id,role"),
    authLastSeenMap(),
  ]);
  const byUser = {};
  for (const r of roles || []) (byUser[r.user_id] = byUser[r.user_id] || []).push(r.role);
  // lastSeenAt prefers the in-app heartbeat (0035) and falls back to the
  // auth sign-in time for users who haven't opened a page since it shipped.
  return (profiles || []).map((p) => ({ ...p, roles: byUser[p.id] || [], lastSignInAt: lastSeen[p.id] ?? null, lastSeenAt: (p.last_seen || lastSeen[p.id]) ?? null }));
}

// Exact-match lookup across all pages - never trusts server-side ?email=
// filtering, which silently returns unrelated users.
async function findUserIdByEmail(email) {
  const want = String(email).trim().toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const data = await authAdmin("admin/users?per_page=200&page=" + page);
    const users = data.users || [];
    if (!users.length) return null;
    const hit = users.find((u) => String(u.email || "").toLowerCase() === want);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

async function userRoleList(userId) {
  const rows = await sb("user_roles?select=role&user_id=eq." + userId);
  return (rows || []).map((r) => r.role);
}

async function targetProfile(userId) {
  const rows = await sb("profiles?select=email,active&id=eq." + userId);
  return (rows && rows[0]) || null;
}

// One atomic replacement (0040) instead of DELETE-then-INSERT: the old pair
// could land out of order or fail in between, leaving the account with no
// roles at all — which under 0029/0036 is no read access and no write access.
// The function validates against the same five names the check constraint
// allows and returns the resulting set.
async function setUserRoles(userId, roles) {
  try {
    return await sb("rpc/set_user_roles", {
      method: "POST",
      body: JSON.stringify({ p_user_id: userId, p_roles: roles }),
    });
  } catch (e) {
    // PostgREST wraps the RAISE text in JSON; those messages ("unknown role",
    // "no profile row for ...") are written for humans, so surface them as a
    // 400 instead of the generic upstream 502.
    const body = /^Supabase \d+: ([\s\S]*)$/.exec((e && e.message) || "");
    let msg = "";
    try { msg = body ? JSON.parse(body[1]).message || "" : ""; } catch (_) { msg = ""; }
    throw new Error(msg || "Could not save the roles for that account.");
  }
}

// Audit trail for admin_audit (0038): the table is admin-readable with no
// insert policy, so rows can only come from here. Best-effort on purpose — the
// mutation is already durable, and failing the request would report a success
// as an error (and invite a duplicate retry), so a lost row is logged loudly
// instead.
async function audit(admin, action, target, detail) {
  try {
    await sb("admin_audit", {
      method: "POST",
      body: JSON.stringify({
        actor_id: admin.id,
        actor_email: admin.email || null,
        action,
        target: target || null,
        detail: detail || null,
      }),
    });
  } catch (e) {
    console.error("[admin-users] audit write failed for " + action + ":", e.message);
  }
}

// Guard rails so one admin click can't lock every admin out: nobody edits
// their own account through this API, and only a super admin may touch
// another super admin. Returns the target's current roles so callers can
// record the before-state without a second query.
async function assertTargetManageable(caller, userId) {
  if (String(userId) === String(caller.id)) throw new Error("You cannot modify your own account here");
  const targetRoles = await userRoleList(userId);
  if (targetRoles.includes("super_admin") && !caller.isSuper) {
    throw new Error("Only a super admin can modify another super admin");
  }
  return targetRoles;
}

// Granting super_admin is itself a super-admin-only act: without this an
// ordinary admin could hand it to anyone, which is the escalation the
// target-side guard above assumes cannot happen.
function assertCanGrant(roles, caller) {
  if (roles.includes("super_admin") && !caller.isSuper) {
    throw new Error("Only a super admin can grant the super admin role");
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  try {
    const admin = await callerIsAdmin(req);
    if (!admin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    if (MUTATING_ACTIONS.has(body.action) && rateLimited(admin.id)) {
      res.status(429).json({ error: "Too many admin changes at once — wait a minute and try again." });
      return;
    }

    if (body.action === "list") {
      res.status(200).json({ users: await stitchUsers() });
      return;
    }

    if (body.action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      const roles = Array.isArray(body.roles) ? body.roles.filter((r) => VALID_ROLES.includes(r)) : [];
      if (!email.includes("@")) throw new Error("Valid email required");
      if (!roles.length) throw new Error("At least one role required");
      assertCanGrant(roles, admin);

      // Invite-first: POST /invite creates the account AND emails the
      // button-style sign-in link (redirect lands on /login signed-in).
      let emailed = false;
      let user = null;
      let reactivated = false;
      const invRes = await fetch(process.env.SUPABASE_URL + "/auth/v1/invite", {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({
          email,
          redirect_to: process.env.INVITE_REDIRECT_TO || "https://xana-assets.vercel.app/login",
        }),
      });
      if (invRes.ok) {
        emailed = true;
        user = await invRes.json();
      } else {
        const t = await invRes.text();
        if (/already been registered|already exists/i.test(t)) {
          user = await findUserIdByEmail(email);
          if (!user) throw new Error("Account exists but could not be located");
          await assertTargetManageable(admin, user.id);
          // On a live account an "invite" is really a role replacement plus a
          // reactivation, so a plain invite click used to silently un-offboard
          // whoever had been switched off. The admin has to ask for it.
          if (!body.reactivate) {
            res.status(409).json({
              error: "That email already has an account. Re-enabling it turns the account back on and replaces its roles — confirm to continue.",
              needsReactivate: true,
            });
            return;
          }
          reactivated = true;
        } else {
          throw new Error("Auth invite " + invRes.status + ": " + t.slice(0, 200));
        }
      }

      const before = reactivated ? await userRoleList(user.id) : [];
      await sb("profiles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: user.id, email, full_name: body.fullName || null, invited_by: admin.email, active: true }),
      });
      const after = await setUserRoles(user.id, roles);
      await audit(admin, "invite", email, { roles: after, before, emailed, reactivated });

      res.status(200).json({
        ok: true,
        userId: user.id,
        email,
        roles: after,
        emailed,
        reactivated,
        note: emailed
          ? "Invite email sent — they tap the button inside it and land signed-in."
          : "Account re-enabled as confirmed — roles replaced and sign-in turned back on (no email sent).",
      });
      return;
    }

    if (body.action === "create_with_password") {
      // Manual onboarding (no invite email): admin supplies the initial
      // password; user is flagged must_change_password and the apps force a
      // change at first sign-in.
      const email = String(body.email || "").trim().toLowerCase();
      const roles = Array.isArray(body.roles) ? body.roles.filter((r) => VALID_ROLES.includes(r)) : [];
      const password = String(body.password || "");
      if (!email.includes("@")) throw new Error("Valid email required");
      if (!roles.length) throw new Error("At least one role required");
      if (password.length < 8) throw new Error("Password must be at least 8 characters");
      assertCanGrant(roles, admin);

      let user = await findUserIdByEmail(email);
      const existing = !!user;
      if (user) {
        const before = await assertTargetManageable(admin, user.id);
        // Existing account: reset its password and re-flag it. This used to be
        // a bare fetch whose response was never inspected, so a rejected reset
        // still reported ok:true — the admin then handed out a password that
        // didn't work while the old one stayed valid. authAdmin() throws (502)
        // on a non-2xx instead.
        await authAdmin("admin/users/" + user.id, {
          method: "PUT",
          body: JSON.stringify({ password, email_confirm: true }),
        });
        await sb("profiles", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            id: user.id, email, full_name: body.fullName || null,
            invited_by: admin.email, active: true, must_change_password: true,
          }),
        });
        const after = await setUserRoles(user.id, roles);
        await audit(admin, "create_with_password", email, { roles: after, before, existing: true });
        res.status(200).json({
          ok: true,
          userId: user.id,
          email,
          roles: after,
          existing: true,
          note: "Existing account: password replaced and roles set — they'll be forced to change it at first sign-in. Share it out-of-band (in person or phone), not email.",
        });
        return;
      }

      const cr = await authAdmin("admin/users", {
        method: "POST",
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      user = cr;

      await sb("profiles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          id: user.id, email, full_name: body.fullName || null,
          invited_by: admin.email, active: true, must_change_password: true,
        }),
      });
      const after = await setUserRoles(user.id, roles);
      await audit(admin, "create_with_password", email, { roles: after, existing: false });

      res.status(200).json({
        ok: true,
        userId: user.id,
        email,
        roles: after,
        existing: false,
        note: "Created with initial password — they'll be forced to change it at first sign-in. Share the password out-of-band (in person or phone), not email.",
      });
      return;
    }

    if (body.action === "reset_password") {
      // Admin sets a new temporary password for a user; flags them for a
      // forced change at next sign-in (same flow as manual onboarding).
      const userId = String(body.userId || "");
      const password = String(body.password || "");
      if (!userId) throw new Error("userId required");
      await assertTargetManageable(admin, userId);
      if (password.length < 8) throw new Error("Password must be at least 8 characters");
      const prof = await targetProfile(userId);
      await authAdmin("admin/users/" + userId, {
        method: "PUT",
        headers: serviceHeaders(),
        body: JSON.stringify({ password, email_confirm: true }),
      });
      await sb("profiles?id=eq." + userId, {
        method: "PATCH",
        body: JSON.stringify({ must_change_password: true }),
      });
      await audit(admin, "reset_password", (prof && prof.email) || userId, { must_change_password: true });
      res.status(200).json({
        ok: true,
        note: "Password reset — share it out-of-band; the user must change it at next sign-in.",
      });
      return;
    }

    if (body.action === "set_roles") {
      const userId = String(body.userId || "");
      const roles = Array.isArray(body.roles) ? [...new Set(body.roles.filter((r) => VALID_ROLES.includes(r)))] : [];
      if (!userId) throw new Error("userId required");
      assertCanGrant(roles, admin);
      const before = await assertTargetManageable(admin, userId);
      const after = await setUserRoles(userId, roles);
      const prof = await targetProfile(userId);
      await audit(admin, "set_roles", (prof && prof.email) || userId, { before, after });
      res.status(200).json({ ok: true, roles: after });
      return;
    }

    if (body.action === "set_active") {
      const userId = String(body.userId || "");
      if (!userId) throw new Error("userId required");
      // Same guard as the other mutating actions: stop an admin from
      // deactivating themselves (self-lockout) or another admin's account
      // without super_admin rights. callerIsAdmin() below re-admits a
      // deactivated admin only if their profile.active is still true.
      await assertTargetManageable(admin, userId);
      const prof = await targetProfile(userId);
      await sb("profiles?id=eq." + userId, {
        method: "PATCH",
        body: JSON.stringify({ active: !!body.active }),
      });
      await audit(admin, "set_active", (prof && prof.email) || userId, {
        before: prof ? prof.active : null,
        after: !!body.active,
      });
      res.status(200).json({ ok: true, active: !!body.active });
      return;
    }

    if (body.action === "delete_user") {
      const userId = String(body.userId || "");
      if (!userId) throw new Error("userId required");
      const before = await assertTargetManageable(admin, userId);
      const prof = await targetProfile(userId);
      // Delete the auth user FIRST: 0007 cascades profiles + user_roles. The
      // old order (profile first, auth second) could fail in between and leave
      // a sign-in-capable account with no profile — invisible in /admin, but
      // still able to authenticate.
      // Supabase auth admin requires the user id as a PATH segment, not a
      // query param — `?id=` returns 405 Method Not Allowed.
      await authAdmin("admin/users/" + userId, { method: "DELETE" });
      // No-op when the cascade already removed it; belt and braces if a profile
      // row somehow predates the FK.
      await sb("profiles?id=eq." + userId, { method: "DELETE" });
      const left = await sb("profiles?select=id&id=eq." + userId);
      await audit(admin, "delete_user", (prof && prof.email) || userId, { roles: before, active: prof ? prof.active : null });
      if (left && left.length) {
        res.status(200).json({
          ok: false,
          partial: true,
          error: "Sign-in removed, but the profile row survived — delete it in Supabase (profiles) to finish the removal.",
        });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }


    if (body.action === "sync_health") {
      // Admin page reads the mirror queue through here: sharepoint_sync has
      // no RLS policies (service-role only), so the browser cannot query it
      // directly - a client-side select would silently return zero rows.
      // assets(...) names the failed row's asset; payload survives a delete,
      // so an operator can still tell *which* asset is stuck.
      const [rows, all] = await Promise.all([
        sb("sharepoint_sync?select=id,op,status,attempts,last_error,created_at,attempted_at,asset_id,graph_item_id,payload,assets(item_id,asset_tag,title)&status=in.(pending,failed,processing)&order=created_at.desc&limit=50"),
        sb("sharepoint_sync?select=status&status=in.(pending,failed,processing)"),
      ]);
      // Counts come from their own (unlimited) query: the list above is capped
      // at 50 rows, so counting it would under-report a backlog.
      const counts = { pending: 0, failed: 0, processing: 0 };
      for (const r of all || []) if (counts[r.status] !== undefined) counts[r.status]++;
      res.status(200).json({
        rows: (rows || []).map((r) => {
          const asset = r.assets || null;
          const snap = r.payload || null;
          return {
            id: r.id,
            op: r.op,
            status: r.status,
            attempts: r.attempts,
            last_error: r.last_error,
            created_at: r.created_at,
            attempted_at: r.attempted_at,
            item_id: (asset && asset.item_id) || (snap && snap.item_id) || null,
            tag: (asset && asset.asset_tag) || (snap && (snap.asset_tag || snap.title)) || null,
            graph_item_id: r.graph_item_id || null,
          };
        }),
        counts,
      });
      return;
    }

    if (body.action === "requeue") {
      // requeue_failed_sync_rows() is service_role-only (0036/0038): the
      // browser's own key is refused, so the requeue has to come through here.
      const n = await sb("rpc/requeue_failed_sync_rows", { method: "POST", body: "{}" });
      await audit(admin, "requeue", null, { requeued: n, scope: "all failed rows" });
      res.status(200).json({ ok: true, requeued: n });
      return;
    }

    if (body.action === "retry_row") {
      const id = String(body.id || "");
      if (!id) throw new Error("id required");
      const rows = await sb("sharepoint_sync?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "pending", attempts: 0, last_error: null, processed_at: null }),
      });
      if (!rows || !rows.length) throw new Error("That queue row no longer exists.");
      await audit(admin, "requeue", null, { scope: "one row", id, op: rows[0].op });
      res.status(200).json({ ok: true, id: rows[0].id });
      return;
    }
    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    // Never echo internal error text to the client: helper errors (sb/authAdmin)
    // embed raw Supabase/Auth HTTP responses, which can leak internals.
    // Full detail goes to server logs only. User-fixable validation problems
    // (thrown as plain messages below) are safe to surface as 400s.
    console.error("[admin-users]", e);
    const msg = e && e.message ? String(e.message) : "";
    const isInternal = /^(Supabase \d|Auth \d|Auth invite \d)/.test(msg);
    if (isInternal) {
      res.status(502).json({ error: "Upstream service error — please retry. If it persists, contact an admin." });
    } else if (msg && !/internal/i.test(msg)) {
      res.status(400).json({ error: msg }); // validation / client-fixable
    } else {
      res.status(500).json({ error: "Internal error" });
    }
  }
};

module.exports.maxDuration = 15;
