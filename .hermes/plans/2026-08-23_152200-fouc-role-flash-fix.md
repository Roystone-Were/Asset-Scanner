# Flash-of-Unauthorized-Content (FOUC) Fix Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Eliminate the ~1–2s flash where signed-out visitors see all app cards / nav links / gated content before role filtering kicks in.

**Architecture:** The root cause is uniform: every page renders its full chrome in HTML, then JS hides what the user can't have *after* an async session+roles round-trip. Fix = **secure-by-default rendering**: content that depends on roles starts hidden in the markup (`hidden` attribute), and JS reveals it only when roles permit. To avoid pop-in for returning users, last-known roles are cached synchronously in `localStorage` and used for an instant optimistic reveal, then confirmed/corrected after the real fetch. No new infrastructure.

**Tech Stack:** vanilla JS + CSS across `index.html` (landing), `admin/index.html`, `assets/index.html`, `summary/index.html`, `scanner-app/index.html`, plus helpers in `js/supabase-client.js`.

---

## Current Context (verified)

| Page | Gated element | Today's behavior |
|---|---|---|
| `/` landing | 4 tiles with `data-need` (index.html:51-70) | Render visible; hidden by JS post-auth — signed-out users see ALL tiles flash first |
| `/admin` | `#gate` div | starts `display:none` — already correct ✓ |
| `/assets` | `#gate` div | starts `.hidden` — correct ✓ |
| Navbars (every page) | Scan/Assets/Dashboard/Admin links | always rendered; `applyRoleNav()` hides after async roles fetch |
| Sign-out | `XanaSupabase.signOut()` | single path through adapter ✓ |

Two real problems: **landing tiles** flash for everyone, and **navbar links** flash on every page.

---

## Tasks

### Task 1: Role cache + reveal helper in supabase-client.js

**Objective:** One place owns cached-roles read/write and gated-element reveal.

**Files:**
- Modify: `js/supabase-client.js`

**Step 1: Add cache + reveal functions**

After `applyRoleNav` (~line 378), insert:

```js
  // ---------- FOUC guard ----------
  const ROLES_CACHE_KEY = "xana_roles_cache";
  function cacheRoles(roles) {
    try { localStorage.setItem(ROLES_CACHE_KEY, JSON.stringify(roles || [])); } catch (e) {}
  }
  function cachedRoles() {
    try { return JSON.parse(localStorage.getItem(ROLES_CACHE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function clearRolesCache() {
    try { localStorage.removeItem(ROLES_CACHE_KEY); } catch (e) {}
  }

  // Reveal [data-need] tiles + [data-nav] links the given roles allow.
  // Only ever REVEALS here; applyRoleNav does the hiding after fresh fetch.
  function revealGated(roles) {
    const r = roles || [];
    document.querySelectorAll("[data-need]").forEach((el) => {
      if (r.includes(el.dataset.need)) el.hidden = false;
    });
    document.querySelectorAll("[data-nav]").forEach((el) => {
      el.hidden = !r.includes(el.dataset.nav);
    });
    applyRoleNav(r);
  }
```

**Step 2: Clear cache on signout**

In `signOut()`:

```js
  async function signOut() {
    clearRolesCache();
    await client().auth.signOut();
  }
```

**Step 3: Extend applyRoleNav with data-nav**

At the top of `applyRoleNav`:

```js
    document.querySelectorAll("[data-nav]").forEach((el) => {
      el.hidden = !r.includes(el.dataset.nav);
    });
```

**Step 4: Export new names**

Add to `window.XanaSupabase`: `cacheRoles, cachedRoles, clearRolesCache, revealGated`.

**Step 5: Verify parse**

Run: `node -e "new Function(require('fs').readFileSync('js/supabase-client.js','utf8'));console.log('OK')"`
Expected: OK

**Step 6: Commit**

```bash
git add js/supabase-client.js
git commit -m "feat: role cache + revealGated secure-by-default helper"
```

---

### Task 2: Landing page — tiles hidden until revealed

**Objective:** No tile flash for signed-out or wrong-role visitors.

**Files:**
- Modify: `index.html:51-70` (tiles), `index.html:79-113` (boot)

**Step 1: Mark each of the 4 tile anchors `hidden`**

e.g. `<a class="card" href="/scan" data-need="scanner" hidden>` — repeat for assets/dashboard/admin tiles.

**Step 2: Rewrite boot**

Replace the existing boot IIFE body with:

```js
(async function boot() {
  const who = document.getElementById("who");
  const cached = XanaSupabase.cachedRoles();
  if (cached.length) XanaSupabase.revealGated(cached);   // instant optimistic reveal

  const session = await XanaSupabase.getSession().catch(function () { return null; });

  if (!session || !session.user) {
    XanaSupabase.clearRolesCache();
    document.getElementById("tiles").innerHTML =
      '<a class="card" href="/login" style="grid-column:1/-1"><div class="icon">🔐</div><h2>Sign in</h2>' +
      '<p>Use your work email. You will land straight where you are assigned.</p>' +
      '<span class="pill scan">Sign in →</span></a>';
    return;
  }

  const email = String(session.user.email || "").toLowerCase();
  const roles = await XanaSupabase.myRoles();
  XanaSupabase.cacheRoles(roles);
  XanaSupabase.revealGated(roles);

  who.innerHTML = '<div class="who">Signed in as <b>' + esc(email) + '</b>' +
    '<button id="so">Sign out</button></div>';
  document.getElementById("so").addEventListener("click", async function () {
    await XanaSupabase.signOut();
    location.reload();
  });

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
})();
```

**Step 3: Verify parse**

Run: `node -e "const fs=require('fs');const m=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g);new Function(m[m.length-1].replace(/<\/?script>/g,''));console.log('OK')"`
Expected: OK

**Step 4: Commit**

```bash
git add index.html
git commit -m "fix: landing tiles hidden until roles known; cached fast-reveal"
```

---

### Task 3: Navbars — role links hidden by default

**Objective:** Admin/Dashboard/Assets/Scan nav links never flash to unauthorized eyes.

**Files:**
- Modify: navbar HTML in `admin/index.html`, `assets/index.html`, `summary/index.html`, `scanner-app/index.html`

**Step 1: Annotate nav links on each page**

Find each navbar (grep: `grep -n 'href="/scan"' admin/index.html assets/index.html summary/index.html scanner-app/index.html`) and change:

```html
<a href="/scan" data-nav="scanner" hidden>Scan</a>
<a href="/assets" data-nav="asset_viewer" hidden>Assets</a>
<a href="/dashboard" data-nav="dashboard_viewer" hidden>Dashboard</a>
<a href="/admin" data-nav="admin" hidden>Admin</a>
<!-- Home link stays visible -->
```

Keep any `class="active"` attributes intact.

**Step 2: Each page's boot reveals from cache early**

Where each page calls `XanaSupabase.myRoles()`, ensure this ordering:

```js
// before the auth round-trip:
if (window.XanaSupabase.cachedRoles().length) XanaSupabase.revealGated(XanaSupabase.cachedRoles());
// ... session check ...
// after roles arrive:
XanaSupabase.cacheRoles(roles);
XanaSupabase.revealGated(roles);
```

Pages that redirect signed-out users (`/assets`, `/admin`) keep their existing redirect logic — it runs after the cache attempt and needs no change beyond the cache line.

**Step 3: Verify parse per file**

Run:
```bash
for f in admin/index.html assets/index.html summary/index.html scanner-app/index.html; do
  node -e "const fs=require('fs');const m=fs.readFileSync('$f','utf8').match(/<script>([\s\S]*?)<\/script>/g);if(m)new Function(m[m.length-1].replace(/<\/?script>/g,''))"
done && echo ALL_OK
```
Expected: ALL_OK

**Step 4: Commit**

```bash
git add admin/index.html assets/index.html summary/index.html scanner-app/index.html
git commit -m "fix: nav role-links hidden until resolved; cached reveal on every page"
```

---

### Task 4: Deploy + verification matrix

**Objective:** Prove the fix across visitor types on production.

**Step 1:** Push and deploy

```bash
git push origin main && npx vercel deploy --prod --yes
```

**Step 2:** Verification matrix (manual via browser, or computer_use):

| Scenario | Expected |
|---|---|
| Incognito → `/` | Only Sign-in card, zero tile flash |
| Incognito → `/scan` `/assets` `/admin` `/dashboard` | Redirect to `/login?next=…`, no gated content flash |
| Signed-in admin → `/` | Tiles appear instantly from cache, stay |
| Scanner-only user → any page | No Admin link at any point |
| Demoted user (roles changed server-side) → revisit | Brief optimistic reveal from stale cache, corrected ≤1s when fresh roles land |
| Sign out anywhere → `/` | Only Sign-in card |

**Step 3:** Final commit of any touch-ups, push.

---

## Files Likely to Change

| File | Change |
|---|---|
| `js/supabase-client.js` | ROLES_CACHE_KEY helpers, revealGated, data-nav handling in applyRoleNav, signOut clears cache, exports |
| `index.html` | tiles get `hidden`; boot rewritten around cache→fetch→reveal |
| `admin/index.html` | nav links `data-nav` + `hidden`; boot cache line |
| `assets/index.html` | same |
| `summary/index.html` | same |
| `scanner-app/index.html` | same |

## Tests / Validation

1. Syntax: parse-check every touched HTML inline script + supabase-client.js (commands above).
2. Full suite: `npm --prefix scanner-app test` → 41 pass.
3. Production matrix (Task 4 table) via incognito + signed-in sessions.
4. Regression: sign-in flow still lands users on their strongest-role page; offline queue sync unaffected (no changes to write paths).

## Risks / Tradeoffs / Open Questions

- **Stale-cache cosmetic exposure:** a demoted user might briefly see a now-forbidden nav *link* until the fresh roles fetch re-hides it. All actual data stays protected by RLS and per-page gates; only link visibility is briefly optimistic. Accepted tradeoff for no-pop-in UX.
- **Shared-machine sessions:** signing out clears the cache; abandoning without signout leaves cached roles that reveal *links* but never data (RLS denies). Documented behavior.
- **CSS override risk:** pages styling `.navbar_menu a{display:flex}` etc. could defeat `hidden`. Verified current navbars use simple flex children where `hidden` wins; if a future stylesheet sets explicit display on these anchors, switch to a `[data-nav][hidden]{display:none!important}` rule.
- **Open question:** should the landing page also show a generic "My account" card for users whose only role grants nothing? Currently they get redirected by each page's gate anyway; leaving as-is.
