// app.js â€” Xana Asset Summary client: MSAL auth + theme toggle + dashboard
"use strict";
(function () {
  // ---------- Config ----------
  const CLIENT_ID = "7caa51af-9f32-42d8-8264-da5b97c2f8eb";
  const AUTHORITY = "https://login.microsoftonline.com/refrontiergroup.onmicrosoft.com";
  const REDIRECT_URI = location.origin + location.pathname;
  const GRAPH_SCOPES = ["https://graph.microsoft.com/Sites.Read.All"];
  const CURRENCY = "KES";

  const STATUS_COLORS = {
    "In Use": "#22c55e", Available: "#f59e0b", "Under Repair": "#ef4444",
    Lost: "#dc2626", Retired: "#64748b", "Left With": "#a855f7",
  };
  const DEP_COLORS = {
    "Fully depreciated": "#ef4444", "In progress": "#f59e0b", "No data": "#64748b",
  };

  // ---------- Theme ----------
  const STORAGE_THEME = "xana_theme";
  function applyTheme() {
    const stored = localStorage.getItem(STORAGE_THEME) || "dark";
    document.documentElement.setAttribute("data-theme", stored);
    const tog = document.getElementById("themeToggle");
    if (tog) tog.textContent = stored === "light" ? "ðŸŒ™" : "â˜€ï¸";
  }
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", cur);
      localStorage.setItem(STORAGE_THEME, cur);
      document.getElementById("themeToggle").textContent = cur === "light" ? "ðŸŒ™" : "â˜€ï¸";
    });
    applyTheme();
  });
  // ---------- MSAL ----------
  const msalConfig = { auth: { clientId: CLIENT_ID, authority: AUTHORITY, redirectUri: REDIRECT_URI }, cache: { cacheLocation: "localStorage" } };
  const msalApp = new msal.PublicClientApplication(msalConfig);
  let account = null;

  async function initAuth() {
    await msalApp.initialize();
    try {
      const resp = await msalApp.handleRedirectPromise();
      if (resp && resp.account) { account = resp.account; onSignedIn(); return; }
    } catch (e) { console.error("MSAL redirect error:", e); showSignIn("Sign-in error: " + (e.message || e)); return; }
    const all = msalApp.getAllAccounts();
    if (all.length > 0) { account = all[0]; onSignedIn(); return; }
    // no sign-in yet â€” show the Microsoft sign-in button
    showSignIn();
    document.getElementById("signInBtn").onclick = () => { msalApp.loginRedirect({ scopes: GRAPH_SCOPES }); };
  }

  async function getToken() {
    const req = { scopes: GRAPH_SCOPES, account };
    try { const r = await msalApp.acquireTokenSilent(req); return r.accessToken; }
    catch (e) { console.warn("silent token failed, retrying redirect:", e); msalApp.acquireTokenRedirect(req); throw new Error("refreshing session"); }
  }

  // ---------- Auth UI helpers ----------
  function showSignIn(msg) {
    const el = document.getElementById("signin"); if (el) el.style.display = "";
    const m = document.getElementById("main"); if (m) m.style.display = "none";
    const ui = document.getElementById("userInfo"); if (ui) ui.style.display = "none";
    if (msg) { const me = document.getElementById("signinMsg"); if (me) me.textContent = msg; }
    // always wire the sign-in button so it works regardless of when initAuth finishes
    const btn = document.getElementById("signInBtn");
    if (btn) btn.onclick = () => { msalApp.loginRedirect({ scopes: GRAPH_SCOPES }); };
  }
  function showMain() {
    document.getElementById("signin").style.display = "none";
    document.getElementById("main").style.display = "";
    document.getElementById("userInfo").style.display = "flex";
  }
  function onSignedIn() {
    document.getElementById("userName").textContent = account.name || account.username;
    document.getElementById("userInfo").style.display = "flex";
    document.getElementById("signOutBtn").onclick = () => msalApp.logout({ postLogoutRedirectUri: location.origin + location.pathname });
    showMain(); load();
  }

  // ---------- API helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function money(n) { const v = n == null ? 0 : n; return CURRENCY + " " + (v < 0 ? "-" : "") + Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function statusColor(s) { return STATUS_COLORS[s] || "#3b82f6"; }
  function depColor(s) { return DEP_COLORS[s] || "#3b82f6"; }

  async function load() {
    const btn = document.getElementById("refresh"); if (btn) btn.disabled = true;
    const main = document.getElementById("main");
    const meta = document.getElementById("meta");
    main.innerHTML = '<div class="loading"><div class="spinner"></div>Loading live dataâ€¦</div>';
    try {
      const token = await getToken();
      const res = await fetch("/api/summary", { cache: "no-store", headers: { Authorization: "Bearer " + token } });
      if (!res.ok) { throw new Error(await apiError(res)); }
      const d = await res.json();
      render(d, main, meta);
      // user role awareness from API
      const email = (account.username || "").toLowerCase();
      const isAdmin = (d.adminEmails || []).includes(email);
      const badge = document.getElementById("roleBadge");
      if (badge) { badge.textContent = isAdmin ? "ADMIN" : "VIEWER"; badge.style.background = isAdmin ? "#3b82f6" : "#64748b"; }
    } catch (e) {
      console.error(e);
      main.innerHTML = '<div class="errbox">' + esc(e.message || e) + '</div>';
    } finally { if (btn) btn.disabled = false; }
  }
  async function apiError(res) {
    let body = ""; try { body = (await res.json()).error || res.statusText; } catch (e) { body = res.statusText; }
    if (res.status === 401) return "Session expired â€” please refresh the page to sign in again.";
    return "HTTP " + res.status + " â€” " + body;
  }
  function render(d, main, meta) {
    if (meta) meta.textContent = "Updated " + (d.generatedAt ? d.generatedAt.replace("T", " ").slice(0, 19) : new Date().toLocaleString()) + (d.elapsedMs ? " Â· " + d.elapsedMs + "ms" : "");
    const t = d.totals, h = d.dataHealth;
    main.innerHTML =
      '<div class="kpis">' +
      kpi("Total", t.total) + kpi("Purchase Value", money(t.purchaseValue), t.missingPurchase + " missing") +
      kpi("Book Value", money(t.bookValue), "after depreciation", "acc") + kpi("Fully Depreciated", t.fullyDepreciated, "of " + t.total) +
      kpi("Annual Expense", money(t.expensedThisYear), "straight-line") + "</div>" +
      '<div class="grid">' + panel(donut(d.byStatus), "Status") + panel(bars(d.byType, "#3b82f6"), "By Type") +
      panel(bars(d.byLocation, "#38bdf8"), "By Location") + panel(bars(d.byDepartment, "#a855f7"), "By Department") + "</div>" +
      healthStrip(h) + '<div class="panel"><h2>Asset Register</h2><div class="tbl-scroll">' + tableHtml(d.items) + "</div></div>";
  }
  function kpi(l, v, h, c) {
    return '<div class="kpi ' + (c || "") + '"><div class="label">' + esc(l) + '</div><div class="value">' + esc(v) + "</div>" + (h ? '<div class="hint">' + esc(h) + "</div>" : "") + "</div>";
  }
  function panel(i, t) { return '<div class="panel"><h2>' + esc(t) + "</h2>" + i + "</div>"; }
  function donut(byStatus) {
    const e = Object.entries(byStatus || {}).sort((a, b) => b[1] - a[1]),
      total = e.reduce((s, x) => s + x[1], 0) || 1;
    let acc = 0,
      parts = [];
    for (const [k, v] of e) { parts.push({ k, start: acc, end: acc + (v / total) * 100 }); acc += (v / total) * 100; }
    const grad = parts.map((p) => statusColor(p.k) + " " + p.start + "% " + p.end + "%").join(", ");
    const legend = e
      .map(
        ([k, v]) =>
          '<div class="row"><span class="swatch" style="background:' + statusColor(k) + '"></span><span>' + esc(k) + '</span><span class="count">' + v + "</span></div>",
      )
      .join("");
    return (
      '<div class="flex"><div class="donut-wrap">' +
      '<div style="position:absolute;inset:0;border-radius:50%;background:conic-gradient(' + grad + ')"></div>' +
      '<div style="position:absolute;inset:26px;border-radius:50%;background:var(--panel)"></div>' +
      '<div class="donut-center"><div class="n">' + total + '</div><div class="t">assets</div></div></div><div class="legend">' + legend + "</div></div>");
  }
  function bars(obj, color) {
    const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, 10),
      max = Math.max(1, ...e.map((x) => x[1]));
    return (
      '<div class="bars">' +
      e
        .map(
          ([k, v]) =>
            '<div class="bar-row"><div class="bar-top"><span class="lbl">' + esc(k) + '</span><span>' + v + "</span></div>" +
            '<div class="bar-track"><div class="bar-fill" style="width:' + ((v / max) * 100) + "%;background:" + color + '"></div></div></div>',
        )
        .join("") +
      "</div>"
    );
  }
  function healthStrip(h) {
    const it = (c, l, v) => '<div class="item"><div class="h">' + l + '</div><div class="v ' + c + '">' + v + "</div></div>";
    const ok = (v) => (v === 0 ? "good" : "bad");
    return (
      '<div class="health">' +
      it(ok(h.missingTag), "Missing Tag", h.missingTag) + it(ok(h.missingSerial), "Missing Serial", h.missingSerial) +
      it(ok(h.missingPurchase), "Missing Purchase", h.missingPurchase) + it(ok(h.unverified), "Unverified 90d+", h.unverified) +
      "</div>");
  }
  function tableHtml(items) {
    const head = "<tr><th>Tag</th><th>Type</th><th>Model</th><th>Serial</th><th>Employee</th><th>Location</th><th>Status</th><th>Purchased</th><th>Price</th><th>Book Value</th><th>Dep</th></tr>";
    return (
      '<table><thead>' + head + "</thead><tbody>" +
      items
        .map(
          (i) =>
            "<tr><td><b>" + esc(i.tag) + "</b></td><td>" + esc(i.type) + "</td><td>" + esc(i.model) + "</td><td>" +
            esc(i.serial) + "</td><td>" + esc(i.employee) + "</td><td>" + esc(i.location) + "</td>" +
            '<td><span class="pill" style="background:' + statusColor(i.status) + '">' + esc(i.status) + "</span></td>" +
            "<td>" + esc(i.purchaseDate) + "</td><td>" + money(i.purchasePrice) + '</td><td><b>' + money(i.bookValue) + "</b></td>" +
            '<td><span class="pill" style="background:' + depColor(i.depStatus) + '">' + esc(i.depStatus) + "</span></td></tr>",
        )
        .join("") +
      "</tbody></table>");
  }

  // ---------- Boot ----------
  initAuth();
})();


