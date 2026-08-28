// Vercel serverless function — admin user management
// POST /api/admin-users   Authorization: Bearer <Supabase access token>
// Body: { action, ... }
//   list                          -> all users with profile + roles
//   invite {email, fullName, roles[]}  -> create auth user + profile + roles
//   set_roles {userId, roles[]}   -> replace role set
//   set_active {userId, active}   -> enable/disable login
// Every call re-verifies the caller's JWT and admin role server-side.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const VALID_ROLES = ["admin", "scanner", "asset_viewer", "dashboard_viewer"];

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
    sb("profiles?select=id,email,full_name,active,invited_by,created_at&order=created_at.asc"),
    sb("user_roles?select=user_id,role"),
    authLastSeenMap(),
  ]);
  const byUser = {};
  for (const r of roles || []) (byUser[r.user_id] = byUser[r.user_id] || []).push(r.role);
  return (profiles || []).map((p) => ({ ...p, roles: byUser[p.id] || [], lastSignInAt: lastSeen[p.id] ?? null }));
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

// Guard rails so one admin click can't lock every admin out: nobody edits
// their own account through this API, and only a super admin may touch
// another super admin.
async function assertTargetManageable(caller, userId) {
  if (String(userId) === String(caller.id)) throw new Error("You cannot modify your own account here");
  const targetRoles = await userRoleList(userId);
  if (targetRoles.includes("super_admin") && !caller.isSuper) {
    throw new Error("Only a super admin can modify another super admin");
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

    if (body.action === "list") {
      res.status(200).json({ users: await stitchUsers() });
      return;
    }

    if (body.action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      const roles = Array.isArray(body.roles) ? body.roles.filter((r) => VALID_ROLES.includes(r)) : [];
      if (!email.includes("@")) throw new Error("Valid email required");
      if (!roles.length) throw new Error("At least one role required");

      // Invite-first: POST /invite creates the account AND emails the
      // button-style sign-in link (redirect lands on /login signed-in).
      let emailed = false;
      let user = null;
      const invRes = await fetch(process.env.SUPABASE_URL + "/auth/v1/invite", {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({
          email,
          redirect_to: process.env.INVITE_REDIRECT_TO || "https://asset-system-tau.vercel.app/login",
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
        } else {
          throw new Error("Auth invite " + invRes.status + ": " + t.slice(0, 200));
        }
      }

      await sb("profiles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: user.id, email, full_name: body.fullName || null, invited_by: admin.email, active: true }),
      });
      await sb("user_roles?user_id=eq." + user.id, { method: "DELETE" });
      await sb("user_roles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(roles.map((r) => ({ user_id: user.id, role: r }))),
      });

      res.status(200).json({
        ok: true,
        userId: user.id,
        email,
        roles,
        emailed,
        note: emailed
          ? "Invite email sent — they tap the button inside it and land signed-in."
          : "Account already existed (no email sent) — they can sign in at /login anytime.",
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

      let user = await findUserIdByEmail(email);
      if (user) await assertTargetManageable(admin, user.id);
      if (!user) {
        const cr = await authAdmin("admin/users", {
          method: "POST",
          body: JSON.stringify({ email, password, email_confirm: true }),
        });
        user = cr;
      } else {
        // Existing account: reset its password and re-flag it.
        await fetch(process.env.SUPABASE_URL + "/auth/v1/admin/users/" + user.id, {
          method: "PUT",
          headers: serviceHeaders(),
          body: JSON.stringify({ password, email_confirm: true }),
        });
      }

      await sb("profiles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          id: user.id, email, full_name: body.fullName || null,
          invited_by: admin.email, active: true, must_change_password: true,
        }),
      });
      await sb("user_roles?user_id=eq." + user.id, { method: "DELETE" });
      await sb("user_roles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(roles.map((r) => ({ user_id: user.id, role: r }))),
      });

      res.status(200).json({
        ok: true,
        userId: user.id,
        email,
        roles,
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
      await authAdmin("admin/users/" + userId, {
        method: "PUT",
        headers: serviceHeaders(),
        body: JSON.stringify({ password, email_confirm: true }),
      });
      await sb("profiles?id=eq." + userId, {
        method: "PATCH",
        body: JSON.stringify({ must_change_password: true }),
      });
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
      await assertTargetManageable(admin, userId);
      await sb("user_roles?user_id=eq." + userId, { method: "DELETE" });
      if (roles.length) {
        await sb("user_roles", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(roles.map((r) => ({ user_id: userId, role: r }))),
        });
      }
      res.status(200).json({ ok: true, roles });
      return;
    }

    if (body.action === "set_active") {
      const userId = String(body.userId || "");
      if (!userId) throw new Error("userId required");
      await sb("profiles?id=eq." + userId, {
        method: "PATCH",
        body: JSON.stringify({ active: !!body.active }),
      });
      res.status(200).json({ ok: true, active: !!body.active });
      return;
    }

    if (body.action === "delete_user") {
      const userId = String(body.userId || "");
      if (!userId) throw new Error("userId required");
      await assertTargetManageable(admin, userId);
      await sb("profiles?id=eq." + userId, { method: "DELETE" });
      // Supabase auth admin requires the user id as a PATH segment, not a
      // query param — `?id=` returns 405 Method Not Allowed.
      await authAdmin("admin/users/" + userId, { method: "DELETE" });
      res.status(200).json({ ok: true });
      return;
    }


    if (body.action === "sync_health") {
      // Admin page reads the mirror queue through here: sharepoint_sync has
      // no RLS policies (service-role only), so the browser cannot query it
      // directly - a client-side select would silently return zero rows.
      const rows = await sb(
        "sharepoint_sync?select=op,status,attempts,last_error,created_at&status=in.(pending,failed,processing)&order=created_at.desc&limit=50"
      );
      res.status(200).json({ rows: rows || [] });
      return;
    }
    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("[admin-users]", e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
};

module.exports.maxDuration = 15;
