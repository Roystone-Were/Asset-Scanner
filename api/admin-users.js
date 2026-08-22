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
    if (!(roles || []).some((r) => r.role === "admin")) return null;
    return me;
  } catch (e) {
    console.error("[admin-users] caller verify failed:", e.message);
    return null;
  }
}

async function stitchUsers() {
  const [profiles, roles] = await Promise.all([
    sb("profiles?select=id,email,full_name,active,invited_by,created_at&order=created_at.asc"),
    sb("user_roles?select=user_id,role"),
  ]);
  const byUser = {};
  for (const r of roles || []) (byUser[r.user_id] = byUser[r.user_id] || []).push(r.role);
  return (profiles || []).map((p) => ({ ...p, roles: byUser[p.id] || [] }));
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

      let user;
      try {
        user = await authAdmin("admin/users", {
          method: "POST",
          body: JSON.stringify({ email, email_confirm: true }),
        });
      } catch (e) {
        if (/already been registered|already exists/i.test(e.message)) {
          const page = await authAdmin("admin/users?email=" + encodeURIComponent(email));
          user = (page.users || [])[0];
          if (!user) throw e;
        } else throw e;
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

      res.status(200).json({ ok: true, userId: user.id, email, roles, existedAlready: !!user.last_sign_in_at });
      return;
    }

    if (body.action === "set_roles") {
      const userId = String(body.userId || "");
      const roles = Array.isArray(body.roles) ? [...new Set(body.roles.filter((r) => VALID_ROLES.includes(r)))] : [];
      if (!userId) throw new Error("userId required");
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
      await sb("profiles?id=eq." + userId, { method: "DELETE" });
      await authAdmin("admin/users?id=" + userId, { method: "DELETE" });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("[admin-users]", e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
};

module.exports.maxDuration = 15;
