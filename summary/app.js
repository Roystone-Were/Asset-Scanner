// app.js —” Xana Asset Summary client: Supabase auth + theme toggle + dashboard
"use strict";
(function () {
  // ---------- Config ----------
  const CURRENCY = "KES";

  const STATUS_COLORS = {
    "In Use": "#22c55e", Available: "#f59e0b", "Under Repair": "#ef4444",
    Lost: "#dc2626", Retired: "#64748b", "Left With": "#a855f7",
  };
const PAGE_SIZE = 50;
let currentPage = 0, lastItems = [];
const DEP_COLORS = {
    "Fully depreciated": "#ef4444", "In progress": "#f59e0b", "No data": "#64748b",
  };

  // ---------- Theme (light default, shared key with scanner) ----------
  const STORAGE_THEME = "xana_theme";
  function applyTheme() {
    const stored = localStorage.getItem(STORAGE_THEME) || "light";
    document.documentElement.setAttribute("data-theme", stored);
    const tog = document.getElementById("themeToggle");
    if (tog) tog.textContent = stored === "dark" ? "☀️" : "☽";
  }
  applyTheme(); // apply immediately on script load
  document.addEventListener("DOMContentLoaded", () => {
    const tog = document.getElementById("themeToggle");
    if (tog) {
      tog.addEventListener("click", () => {
        const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", cur);
        localStorage.setItem(STORAGE_THEME, cur);
        tog.textContent = cur === "dark" ? "☀️" : "☽";
      });
    }
  });
  // ---------- Auth (single sign-in page at /login) ----------
  let account = null;

  async function initAuth() {
    const session = await XanaSupabase.getSession().catch(() => null);
    if (!session || !session.user) return false;
    account = { username: String(session.user.email || "").toLowerCase(), name: session.user.email };
    const roles = await XanaSupabase.myRoles();
    if (!(roles.includes("dashboard_viewer") || roles.includes("admin"))) {
      showSignIn("Your account has no dashboard access. Contact IT Admin (roystone@xanalife.com).");
      const btn = document.getElementById("signInBtn");
      if (btn) btn.onclick = () => { location.href = "/login?next=/dashboard"; };
      return false;
    }
    XanaSupabase.applyRoleNav(roles);
    onSignedIn();
    return true;
  }

  // ---------- Auth UI helpers ----------
  function showSignIn(msg) {
    const el = document.getElementById("signin"); if (el) el.style.display = "";
    const m = document.getElementById("main"); if (m) m.style.display = "none";
    const ui = document.getElementById("userInfo"); if (ui) ui.style.display = "none";
    if (msg) { const me = document.getElementById("signinMsg"); if (me) me.textContent = msg; }
    const btn = document.getElementById("signInBtn");
    if (btn) btn.onclick = () => { location.href = "/login?next=" + encodeURIComponent(location.pathname); };
  }
  function showMain() {
    document.getElementById("signin").style.display = "none";
    document.getElementById("main").style.display = "";
    document.getElementById("userInfo").style.display = "flex";
  }
  function onSignedIn() {
    document.getElementById("userName").textContent = account.name || account.username;
    document.getElementById("userInfo").style.display = "flex";
    document.getElementById("signOutBtn").onclick = async () => { await XanaSupabase.signOut(); location.href = "/login"; };
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
    main.innerHTML = '<div class="loading"><div class="spinner"></div>Loading live data—¦</div>';
    try {
      const items = await XanaSupabase.listAssetsDetailed();
      const d = XanaSupabase.computeSummary(items);
      render(d, main, meta);
      const isAdminUser = (await XanaSupabase.myRoles()).includes("admin");
      const badge = document.getElementById("roleBadge");
      if (badge) { badge.textContent = isAdminUser ? "ADMIN" : "VIEWER"; badge.style.background = isAdminUser ? "#3b82f6" : "#64748b"; }
    } catch (e) {
      console.error(e);
      main.innerHTML = '<div class="errbox">' + esc(e.message || e) + '</div>';
    } finally { if (btn) btn.disabled = false; }
  }
  function render(d, main, meta) {
    if (meta) meta.textContent = "Last fetched: " + new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi", year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short" });
    const t = d.totals;
    const h = d.dataHealth;
    // Store items for pagination and reset to first page
    lastItems = d.items || [];
    currentPage = 0;

    // Calculate health score (0-100) for conditional coloring
    const healthScore = calculateHealthScore(h, t.total);

    main.innerHTML =
      `<div class="kpis">
        ${kpi("Total Assets", t.total, null, null, "neutral")}
        ${kpi("Purchase Value", money(t.purchaseValue), t.missingPurchase + " missing", t.missingPurchase > t.total * 0.3 ? "warn" : "neutral")}
        ${kpi("Book Value", money(t.bookValue), "after depreciation", "acc")}
        ${kpi("Fully Depreciated", t.fullyDepreciated, pct(t.fullyDepreciated, t.total), t.fullyDepreciated > t.total * 0.5 ? "warn" : "neutral")}
        ${kpi("Data Health", healthScore + "%", h.unverified + " unverified 90d+", healthScore >= 80 ? "good" : healthScore >= 50 ? "warn" : "bad")}
      </div>` +
      financePanel(d.finance) +
      `<div class="grid">${panel(donut(d.byStatus), "Status")}${panel(bars(d.byType, "#3b82f6"), "By Type")}${panel(bars(d.byLocation, "#38bdf8"), "By Location")}${panel(bars(d.byDepartment, "#a855f7"), "By Department")}</div>` +
      healthStrip(h) +
      `<div class="panel"><h2>Asset Register</h2><div id="tblInfo" style="margin-bottom:6px;font-size:.82rem;color:var(--muted);"></div><div class="tbl-scroll" id="tblBody"></div><div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><button class="editbtn" id="prevBtn" onclick="changePage(-1)">Prev</button><button class="editbtn" id="nextBtn" onclick="changePage(1)">Next</button><button class="editbtn" id="exportCsv" style="margin-left:auto;background:var(--green);">📥 Export CSV</button></div></div>`;

    // Now populate the table after the DOM elements exist
    renderTable();

    // Wire the export button
    const exportBtn = document.getElementById("exportCsv");
    if (exportBtn) exportBtn.onclick = exportToCsv;

    // Build the print-only exec one-pager and enable its button
    mountExecPage(d);
    const execBtn = document.getElementById("execBtn");
    if (execBtn) {
      execBtn.style.display = "";
      execBtn.onclick = () => {
        document.body.classList.add("print-exec");
        window.print();
        setTimeout(() => document.body.classList.remove("print-exec"), 500);
      };
    }

    // Animate KPI numbers and bars
    animateKpis();
    requestAnimationFrame(() => requestAnimationFrame(animateBars));
  }

  // ---------- Health Score Calculation ----------
  function calculateHealthScore(h, total) {
    if (total === 0) return 100;
    const tagScore = Math.max(0, 100 - (h.missingTag / total) * 100);
    const serialScore = Math.max(0, 100 - (h.missingSerial / total) * 100);
    const purchaseScore = Math.max(0, 100 - (h.missingPurchase / total) * 100);
    const verifiedScore = Math.max(0, 100 - (h.unverified / total) * 100);
    return Math.round((tagScore + serialScore + purchaseScore + verifiedScore) / 4);
  }

  function pct(part, total) {
    if (total === 0) return "0%";
    return Math.round(part / total * 100) + "%";
  }

  // ---------- Financial framing ----------
  function financePanel(f) {
    if (!f) return "";
    const it = (c, l, v, s) => '<div class="item"><div class="h">' + l + '</div><div class="v ' + c + '">' + v + "</div>" + (s ? '<div class="s">' + s + "</div>" : "") + "</div>";
    return (
      '<div class="panel" style="margin:14px 0;"><h2>Financial Position</h2>' +
      '<div class="fin-grid">' +
      it("", "Annual Depreciation", money(f.annualDepreciation), "P&L impact per year") +
      it("warn", "Replacement due ≤12mo", f.replacementDue12mo + " assets · " + money(f.replacementCost12mo), "Fully or nearly depreciated") +
      it("good", "Idle stock (unassigned)", f.idleAssets + " assets · " + money(f.idleBookValue) + " book value", "Redeploy before buying new") +
      it(lostAssetsClass(f.lostAssets), "Lost assets", f.lostAssets + " · " + money(f.lostCost) + " cost", "Write-off exposure") +
      "</div></div>");
  }
  function lostAssetsClass(n) { return n > 0 ? "bad" : "good"; }

  // ---------- Exec one-pager ----------
  function mountExecPage(d) {
    const host = document.getElementById("execPage");
    if (!host) return;
    const t = d.totals || {};
    const f = d.finance || {};
    const h = d.dataHealth || {};

    const finRow = (l, v, note) =>
      "<tr><td><b>" + esc(l) + "</b></td><td>" + esc(v) + "</td><td>" + esc(note || "") + "</td></tr>";
    const distRow = (k, n, tot) =>
      '<div class="ep-row"><span>' + esc(k) + '</span><span><b>' + n + '</b> (' + pct(n, tot || 1) + ')</span></div>';

    const topList = (obj) => {
      const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const tot = e.reduce((s, x) => s + x[1], 0);
      return e.length
        ? e.map(([k, v]) => distRow(k, v, tot)).join("")
        : '<div class="ep-row"><span>—</span><span></span></div>';
    };

    host.innerHTML =
      '<div class="ep-head"><h2>Xana Asset Portfolio — Executive Summary</h2>' +
      '<div class="ep-date">Refrontier Group · as of ' + new Date().toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", year: "numeric", month: "long", day: "numeric" }) + '</div></div>' +
      '<div class="ep-kpis">' +
      '<div class="ep-kpi"><div class="l">Portfolio size</div><div class="v">' + t.total + '</div><div class="n">assets on register</div></div>' +
      '<div class="ep-kpi"><div class="l">Original cost</div><div class="v">' + money(t.purchaseValue) + '</div><div class="n">total purchase value</div></div>' +
      '<div class="ep-kpi"><div class="l">Current value</div><div class="v">' + money(t.bookValue) + '</div><div class="n">net book value today</div></div>' +
      '<div class="ep-kpi"><div class="l">Value lost to age</div><div class="v">' + money((t.purchaseValue - t.bookValue)) + '</div><div class="n">accumulated depreciation</div></div>' +
      '</div>' +
      '<table class="ep-fin"><thead><tr><th>Financial position</th><th></th><th></th></tr></thead><tbody>' +
      finRow("Annual depreciation expense", money(f.annualDepreciation), "hits P&L each year") +
      finRow("Replacement due within 12 months", f.replacementDue12mo + " assets · " + money(f.replacementCost12mo), "budget planning figure") +
      finRow("Idle stock (unassigned)", f.idleAssets + " assets · " + money(f.idleBookValue), "redeploy before buying new") +
      finRow("Lost assets", f.lostAssets + " · " + money(f.lostCost), "write-off exposure") +
      finRow("Missing purchase records", String(h.missingPurchase ?? "—"), "limits valuation accuracy") +
      "</tbody></table>" +
      '<div class="ep-cols">' +
      '<div><h3>Status</h3>' + topList(d.byStatus) + '</div>' +
      '<div><h3>Top departments</h3>' + topList(d.byDepartment) + '</div>' +
      '<div><h3>Locations</h3>' + topList(d.byLocation) + '</div>' +
      '</div>' +
      '<div class="ep-foot">Straight-line depreciation · Source of truth: SharePoint Xana Asset Inventory · Generated from live data</div>';
  }

  // ---------- KPI Animation ----------
  function animateKpis() {
    const kpiEls = document.querySelectorAll(".kpi .value");
    kpiEls.forEach(el => {
      const text = el.textContent;
      // Extract numeric value for animation
      const numMatch = text.match(/[\d,]+/);
      if (!numMatch) return;

      const target = parseInt(numMatch[0].replace(/,/g, ""), 10);
      const prefix = text.substring(0, text.indexOf(numMatch[0]));
      const suffix = text.substring(text.indexOf(numMatch[0]) + numMatch[0].length);

      let current = 0;
      const duration = 800;
      const start = performance.now();

      function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        current = Math.round(target * eased);
        el.textContent = prefix + current.toLocaleString() + suffix;

        if (progress < 1) requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
    });
  }
  function kpi(l, v, h, status, extraClass) {
    const statusClass = status || "neutral";
    return '<div class="kpi ' + (extraClass || "") + " kpi-" + statusClass + '"><div class="label">' + esc(l) + '</div><div class="value">' + esc(v) + "</div>" + (h ? '<div class="hint">' + esc(h) + "</div>" : "") + "</div>";
  }
  function panel(i, t) { return '<div class="panel"><h2>' + esc(t) + "</h2>" + i + "</div>"; }
  function donut(byStatus) {
    // Derive statuses dynamically from API data instead of hardcoded list
    const e = Object.entries(byStatus || {}).sort((a, b) => b[1] - a[1]),
      total = e.reduce((s, x) => s + x[1], 0) || 1;
    let acc = 0,
      parts = [];
    for (const [k, v] of e) { parts.push({ k, start: acc, end: acc + (v / total) * 360 }); acc += (v / total) * 360; }

    // Build SVG donut with hoverable segments
    const R = 80;       // outer radius
    const r = 56;       // inner radius (donut hole)
    const cx = 90, cy = 90; // center (svg is 180x180)
    let svgPaths = "";
    let angle = -90; // start at 12 o'clock
    for (const p of parts) {
      const sweep = (p.end - p.start);
      const largeArc = sweep > 180 ? 1 : 0;
      const startRad = angle * Math.PI / 180;
      const endRad = (angle + sweep) * Math.PI / 180;
      const x1 = cx + R * Math.cos(startRad);
      const y1 = cy + R * Math.sin(startRad);
      const x2 = cx + R * Math.cos(endRad);
      const y2 = cy + R * Math.sin(endRad);
      const x3 = cx + r * Math.cos(endRad);
      const y3 = cy + r * Math.sin(endRad);
      const x4 = cx + r * Math.cos(startRad);
      const y4 = cy + r * Math.sin(startRad);
      const path = `M ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${largeArc} 0 ${x4} ${y4} Z`;
      const pct = total > 0 ? ((p.end - p.start) / 360 * 100).toFixed(1) : 0;
      svgPaths += `<path d="${path}" fill="${statusColor(p.k)}" data-status="${esc(p.k)}" data-count="${Math.round((p.end - p.start) / 360 * total)}" data-pct="${pct}"><title>${esc(p.k)}: ${pct}% (${Math.round((p.end - p.start) / 360 * total)} assets)</title></path>`;
      angle += sweep;
    }

    const legend = e
      .map(
        ([k, v]) =>
          '<div class="row"><span class="swatch" style="background:' + (v === 0 ? "var(--line)" : statusColor(k)) + '"></span><span>' + esc(k) + '</span><span class="count">' + v + (v > 0 ? " · " + (v / total * 100).toFixed(1) + "%" : "") + "</span></div>",
      )
      .join("");

    return (
      '<div class="flex"><div class="donut-wrap" style="width:180px;height:180px;"><svg viewBox="0 0 180 180" style="width:100%;height:100%;transform:rotate(-90deg);">' +
      svgPaths +
      '</svg><div class="donut-center"><div class="n">' + total + '</div><div class="t">assets</div></div></div><div class="legend">' + legend + "</div></div>");
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
            '<div class="bar-track"><div class="bar-fill" data-w="' + ((v / max) * 100) + '" style="width:0;background:' + color + '"></div></div></div>',
        )
        .join("") +
      "</div>"
    );
  }
  function animateBars() {
    const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.querySelectorAll(".bar-fill").forEach((el, i) => {
      const w = el.getAttribute("data-w") || "0";
      if (prefersReduced) { el.style.width = w + "%"; return; }
      // stagger slightly per row for a nicer sweep
      setTimeout(() => { el.style.width = w + "%"; }, 120 + i * 70);
    });
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
  function renderTable() {
    const info = document.getElementById("tblInfo"), body = document.getElementById("tblBody");
    const prev = document.getElementById("prevBtn"), next = document.getElementById("nextBtn");
    const start = currentPage * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, lastItems.length);
    if (info) info.textContent = "Showing " + (start + 1) + "–" + end + " of " + lastItems.length;
    if (body) body.innerHTML = tableHtml(lastItems.slice(start, end));
    if (prev) prev.disabled = currentPage === 0;
    if (next) next.disabled = end >= lastItems.length;
  }
  // exposed globally for onclick in HTML
  window.changePage = (dir) => { currentPage = Math.max(0, currentPage + dir); if (currentPage * PAGE_SIZE >= lastItems.length) currentPage = Math.max(0, Math.floor((lastItems.length - 1) / PAGE_SIZE)); renderTable(); };

  // ---------- CSV Export ----------
  function exportToCsv() {
    if (!lastItems.length) return;
    const headers = ["Tag", "Type", "Model", "Serial", "Employee", "Location", "Status", "Purchase Date", "Purchase Price", "Book Value", "Depreciation Status"];
    const rows = lastItems.map(i => [
      i.tag, i.type, i.model, i.serial, i.employee, i.location, i.status,
      i.purchaseDate, i.purchasePrice, i.bookValue, i.depStatus
    ].map(v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "asset-register-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // ---------- Boot ----------
  initAuth();
})();






