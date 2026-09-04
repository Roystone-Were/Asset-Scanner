// app.js — Xana Asset Summary client: Supabase auth + theme toggle + dashboard
"use strict";
(function () {
  // ---------- Config ----------
  const CURRENCY = "KES";

  // Keys must match app_choices.status exactly -- this map is looked up by
  // exact key, so a status missing here renders in the fallback blue. "In
  // Repair" is the live value; "Under Repair" is kept for legacy rows.
  const STATUS_COLORS = {
    "In Use": "#16a34a", Available: "#d97706",
    "In Repair": "#dc2626", "Under Repair": "#dc2626",
    "Under Investigation": "#c2410c",
    Lost: "#991b1b", Retired: "#64748b", "Left With": "#7c3aed",
  };
const PAGE_SIZE = 50;
let currentPage = 0, lastItems = [];
const DEP_COLORS = {
    "Fully depreciated": "#dc2626", "In progress": "#d97706", "No data": "#64748b",
  };

  // ---------- Theme (light default, shared key with scanner) ----------
  const STORAGE_THEME = "xana_theme";
  function applyTheme() {
    const stored = localStorage.getItem(STORAGE_THEME) || "light";
    document.documentElement.setAttribute("data-theme", stored);
    const tog = document.getElementById("themeToggle");
    if (tog) tog.setAttribute("aria-checked", stored === "dark");
  }
  applyTheme(); // apply immediately on script load
  document.addEventListener("DOMContentLoaded", () => {
    const tog = document.getElementById("themeToggle");
    if (tog) {
      tog.addEventListener("click", () => {
        const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", cur);
        localStorage.setItem(STORAGE_THEME, cur);
        tog.setAttribute("aria-checked", cur === "dark");
      });
    }
  });
  // ---------- Auth (single sign-in page at /login) ----------
  let account = null;

  async function initAuth() {
    const session = await XanaSupabase.getSession().catch(() => null);
    const boot = document.getElementById("boot");
    if (!session || !session.user) {
      showSignIn();                                   // signed out → show sign-in card
      if (boot) { boot.classList.add("done"); setTimeout(() => boot.remove(), 300); }
      return false;
    }
    account = { username: String(session.user.email || "").toLowerCase(), name: session.user.email };
    const roles = await XanaSupabase.myRoles();
    if (!(roles.includes("dashboard_viewer") || roles.includes("admin") || roles.includes("super_admin"))) {
      const l = await XanaSupabase.landingFor();
      location.href = l || "/login";
      return false;
    }
    XanaSupabase.applyRoleNav(roles);
    onSignedIn();
    if (boot) { boot.classList.add("done"); setTimeout(() => boot.remove(), 300); }
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
  const CSV_DQ = String.fromCharCode(34);
  const CSV_TICK = String.fromCharCode(39);
  // Explicit list, not a character class: "[=+-@]" reads + to @ as a RANGE,
  // which swallows every digit and would prefix every number in the export.
  const CSV_RISKY = ["=", "+", "-", "@", String.fromCharCode(9), String.fromCharCode(13)];
  function statusColor(s) { return STATUS_COLORS[s] || "#3b82f6"; }
  function depColor(s) { return DEP_COLORS[s] || "#3b82f6"; }

  // CSV cell that cannot execute as a spreadsheet formula (=, +, -, @, tab).
  function csvCell(v) {
    let s = String(v == null ? "" : v);
    if (CSV_RISKY.indexOf(s.charAt(0)) > -1) s = CSV_TICK + s;
    return CSV_DQ + s.split(CSV_DQ).join(CSV_DQ + CSV_DQ) + CSV_DQ;
  }

  // KPI-sized money: the currency becomes a small muted prefix so the number
  // leads and the pair never breaks across two lines. Reuses money() rather
  // than repeating its grouping logic.
  function moneyKpi(n) {
    const full = money(n);
    const sp = full.indexOf(" ");
    if (sp < 0) return esc(full);
    return '<span class="cur">' + esc(full.slice(0, sp)) + "</span>" + esc(full.slice(sp + 1));
  }

  async function load() {
    const btn = document.getElementById("refresh"); if (btn) btn.disabled = true;
    const main = document.getElementById("main");
    const meta = document.getElementById("meta");
    main.innerHTML = '<div class="loading"><div class="spinner"></div>Loading live data…</div>';
    try {
      const items = await XanaSupabase.listAssetsDetailed();
      const d = XanaSupabase.computeSummary(items);
      render(d, main, meta);
      // IT widget: open issues + recent events (non-fatal if it fails)
      try {
        await mountItWidget(main, items);
      } catch (e) { console.warn("IT widget:", e); }
      // Warranty expiries (non-fatal)
      try { mountWarrantyWidget(items); } catch (e) { console.warn("warranty widget:", e); }
      const isAdminUser = (await XanaSupabase.myRoles()).some(r => r === "admin" || r === "super_admin");
      const badge = document.getElementById("roleBadge");
      if (badge) { badge.textContent = isAdminUser ? "ADMIN" : "VIEWER"; badge.style.background = isAdminUser ? "#3b82f6" : "#64748b"; }
    } catch (e) {
      console.error(e);
      main.innerHTML = '<div class="errbox">' + esc(e.message || e) + '</div>';
    } finally { if (btn) btn.disabled = false; }
  }

  // Warranty expiry widget: assets expiring within 90 days, or recently expired
  function warrantyExpiry(i) {
    if (!i.warrantyMonths || !i.purchaseDate) return null;
    const d = new Date(i.purchaseDate + "T00:00:00");
    if (isNaN(d.getTime())) return null;
    const expiry = (() => {
      // Clamp to month-end: Jan 31 + 1mo must be Feb 28/29, not Mar 3.
      const y = d.getFullYear(), m = d.getMonth() + Math.round(i.warrantyMonths), day = d.getDate();
      const lastDay = new Date(y, m + 1, 0).getDate();
      return new Date(y, m, Math.min(day, lastDay));
    })();
    return { expiry, days: Math.ceil((expiry - new Date()) / 86400000) };
  }
  function mountWarrantyWidget(items) {
    const body = document.getElementById("warrantyBody");
    if (!body) return;
    const rows = items
      .map(i => ({ i, w: warrantyExpiry(i) }))
      .filter(x => x.w && x.w.days <= 90)
      .sort((a, b) => a.w.days - b.w.days);
    if (!rows.length) {
      body.innerHTML = "No warranties expiring in the next 90 days.";
      return;
    }
    body.innerHTML = rows.map(({ i, w }) => {
      const color = w.days < 0 ? "#dc2626" : w.days <= 30 ? "#ff8c00" : "var(--text)";
      const state = w.days < 0 ? "EXPIRED" : w.days + " days left";
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed var(--line)">' +
        '<span><b>' + esc(i.tag || "#" + i.id) + "</b> — " + esc(i.type || "") + "</span>" +
        '<span style="color:' + color + '">' + w.expiry.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + " · " + state + "</span></div>";
    }).join("");
  }

  async function mountItWidget(main, items) {
    const client = XanaSupabase.client();
    const [openIssues, recent] = await Promise.all([
      client.from("asset_events").select("id,item_id,event_type,event_date,description,created_by").eq("event_type", "issue").eq("resolved", false).order("event_date", { ascending: false }).limit(20),
      client.from("asset_events").select("id,item_id,event_type,event_date,description,cost,resolved").in("event_type", ["repair", "maintenance"]).order("event_date", { ascending: false }).limit(8),
    ]);
    if (openIssues.error || recent.error) {
      // A failed events query returns no thrown error - never present
      // "None open" when we simply could not look.
      console.warn("asset_events query failed:", openIssues.error || recent.error);
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.style.marginTop = "14px";
      panel.innerHTML = '<h2>Field activity</h2><div style="font-size:.82rem;color:var(--muted)">Temporarily unavailable — open issues and repairs could not be loaded.</div>';
      main.appendChild(panel);
      return;
    }
    const tagFor = {}; items.forEach(i => { tagFor[i.id] = i.tag || i.serial || ("#" + i.id); });
    const issues = openIssues.data || [];
    const repairs = recent.data || [];
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.style.marginTop = "14px";
    let html = "<h2>Field activity</h2>";
    if (!issues.length && !repairs.length) {
      // Nothing on either side yet -- a full two-column grid with two "nothing
      // here" messages is pure vertical weight for zero information. Collapse
      // to one line, and point at how to actually populate it.
      html += '<div style="font-size:.82rem;color:var(--muted)">No open issues or repairs logged yet — use "Log event" on any asset to start tracking.</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
        '<div><h3 style="font-size:.8rem;color:var(--muted);margin-bottom:8px">Open issues (' + issues.length + ')</h3>' +
        (issues.length
          ? issues.map(i => '<div style="font-size:.82rem;padding:5px 0;border-bottom:1px dashed var(--line)"><b>' + esc(tagFor[i.item_id] || "#" + i.item_id) + "</b> — " + esc(i.description) + '<br/><span style="font-size:.7rem;color:var(--muted)">' + new Date(i.event_date).toLocaleDateString() + " · " + esc(i.created_by || "—") + '</span></div>').join("")
          : '<div style="font-size:.8rem;color:var(--muted)">None open</div>') +
        '</div><div><h3 style="font-size:.8rem;color:var(--muted);margin-bottom:8px">Recent repairs &amp; maintenance</h3>' +
        (repairs.length
          ? repairs.map(r => '<div style="font-size:.82rem;padding:5px 0;border-bottom:1px dashed var(--line)"><b>' + esc(tagFor[r.item_id] || "#" + r.item_id) + "</b> — " + esc(r.description) + (r.cost ? ' <b>KES ' + Number(r.cost).toLocaleString() + "</b>" : "") + '<br/><span style="font-size:.7rem;color:var(--muted)">' + new Date(r.event_date).toLocaleDateString() + '</span></div>').join("")
          : '<div style="font-size:.8rem;color:var(--muted)">Nothing logged yet</div>') +
        "</div></div>";
    }
    panel.innerHTML = html;
    main.appendChild(panel);
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

    // Fills the Status panel's dead space under the donut with a verification-freshness breakdown.
    const statusFreshnessBlock =
      '<div style="border-top:1px solid var(--hairline);margin:16px 0 12px"></div>' +
      '<h3 class="sub-h">Verification freshness</h3>' +
      verificationBars(verificationBreakdown(lastItems));
    main.innerHTML =
      `<div class="kpis">
        ${kpi("Total Assets", t.total, "across " + Object.keys(d.byLocation || {}).length + " branches", null, "neutral")}
        ${kpi("Purchase Value", moneyKpi(t.purchaseValue), t.missingPurchase + " missing", t.missingPurchase > t.total * 0.3 ? "warn" : "neutral", "", true)}
        ${kpi("Book Value", moneyKpi(t.bookValue), t.estimatePendingCount > 0 ? "incl. " + t.estimatePendingCount + " estimate-pending · confirmed " + money(t.confirmedBookValue) : "after depreciation", "acc", "", true)}
        ${kpi("Fully Depreciated", t.fullyDepreciated, pct(t.fullyDepreciated, t.total), t.fullyDepreciated > t.total * 0.5 ? "warn" : "neutral")}
        ${kpi("Data Health", healthScore + "%", h.unverified + " unverified 90d+", healthScore >= 80 ? "good" : healthScore >= 50 ? "warn" : "bad")}
      </div>
      <p style="font-size:.72rem;color:var(--muted);margin:-6px 0 10px">Data Health target ≥95% within 60 days · owner: Roystone</p>` +
      financePanel(d.finance) +
      fleetAgePanel(d.fleetAge) +
      // Two independent stacked columns rather than a strict 2x2 grid --
      // CSS Grid rows share height across the row no matter what
      // align-items says, so a tall Status panel forced By Type's row to
      // stay tall even once By Type's own card was short. Each .gcol flows
      // on its own content height, so no more row-height coupling.
      `<div class="grid"><div class="gcol">${panel(statusBars(d.byStatus) + statusFreshnessBlock, "Status")}${panel(bars(d.byLocation, "#3b82f6", 6, "location"), "By Location")}</div><div class="gcol">${panel(bars(d.byType, "#0d9488", 6, "type"), "By Type")}${panel(bars(d.byDepartment, "#8b5cf6", 6, "department"), "By Department")}</div></div>` +
      healthStrip(h) +
      `<div class="panel" id="warrantyPanel"><h2>Warranty expiries</h2><div id="warrantyBody" style="font-size:.85rem;color:var(--muted)">Loading…</div></div>` +
      `<div class="panel"><h2>Asset Register</h2><div id="tblInfo" style="margin-bottom:6px;font-size:.82rem;color:var(--muted);"></div><div class="tbl-scroll" id="tblBody"></div><div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><button class="btn-quiet" id="prevBtn" onclick="changePage(-1)">Prev</button><button class="btn-quiet" id="nextBtn" onclick="changePage(1)">Next</button><button class="btn-outline" id="exportDep" style="margin-left:auto;">Depreciation export</button><button class="btn-outline" id="exportCsv">Export CSV</button></div></div>`;

    // Now populate the table after the DOM elements exist
    renderTable();

    // Wire the export buttons
    const exportBtn = document.getElementById("exportCsv");
    if (exportBtn) exportBtn.onclick = exportToCsv;
    const depBtn = document.getElementById("exportDep");
    if (depBtn) depBtn.onclick = exportDepreciationCsv;

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
      it(f.replacementDue12mo ? "warn" : "", "Replacement due ≤12mo", f.replacementDue12mo + " assets · " + money(f.replacementCost12mo), "Fully or nearly depreciated") +
      it(f.idleAssets ? "warn" : "good", "Idle stock (unassigned)", f.idleAssets + " assets · " + money(f.idleBookValue) + " book value", "Redeploy before buying new") +
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
      '<div class="ep-foot">Straight-line depreciation · Source of truth: Supabase (mirrored to SharePoint) · Generated from live data</div>';
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
  // ---------- Fleet age and refresh ----------
  // A planning view, not an instruction to spend: age is not condition, and
  // the cost shown is what things originally cost, not what replacing them
  // would cost today. Both caveats are printed on the panel because this is
  // the number that gets quoted in a budget meeting.
  function fleetAgePanel(fa) {
    if (!fa) return "";
    const BAND_COLORS = { under50: "#16a34a", to80: "#d97706", to100: "#dc2626", over100: "#991b1b", unknown: "#64748b" };
    const total = Math.max(1, fa.bands.reduce((n, b) => n + b.count, 0));
    // Every asset in the row unpriced means we genuinely do not know, which
    // is not the same as zero. Saying "KES 0" here would read as free.
    const costCell = (cost, count, missing) =>
      count > 0 && missing >= count
        ? '<span style="color:var(--muted)">not costed</span>'
        : money(cost) + (missing ? ' <span style="color:var(--muted);font-size:.72rem">(' + missing + " unpriced)</span>" : "");

    const bandBars =
      '<div class="bars">' +
      fa.bands.map((b) =>
        '<div class="bar-row"><div class="bar-top"><span class="lbl">' + esc(b.label) + '</span><span>' + b.count +
        (b.count ? ' <span style="color:var(--muted);font-weight:400">' + costCell(b.cost, b.count, b.missingPrice) + "</span>" : "") + "</span></div>" +
        '<div class="bar-track"><div class="bar-fill" data-w="' + ((b.count / total) * 100) + '" style="width:0;background:' + (BAND_COLORS[b.key] || "#3b82f6") + '"></div></div></div>'
      ).join("") + "</div>";

    const rows = [];
    if (fa.overdue.count) rows.push(["Already overdue", fa.overdue.count, fa.overdue.cost, fa.overdue.missingPrice]);
    for (const y of fa.forecast) rows.push([String(y.year), y.count, y.cost, y.missingPrice]);
    const forecastTable = rows.length
      ? '<table style="width:100%;font-size:.82rem;border-collapse:collapse;margin-top:4px">' +
        '<thead><tr><th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:600">Due</th>' +
        '<th style="text-align:right;padding:4px 0;color:var(--muted);font-weight:600">Assets</th>' +
        '<th style="text-align:right;padding:4px 0;color:var(--muted);font-weight:600">At original cost</th></tr></thead><tbody>' +
        rows.map(([label, count, cost, missing]) =>
          "<tr><td style=\"padding:4px 0\">" + esc(label) + "</td>" +
          '<td style="text-align:right;padding:4px 0">' + count + "</td>" +
          '<td style="text-align:right;padding:4px 0">' + costCell(cost, count, missing) +
          "</td></tr>"
        ).join("") + "</tbody></table>"
      : '<p style="font-size:.82rem;color:var(--muted);margin:6px 0 0">Nothing reaches end of life in the next three years.</p>';

    const branch = fa.byBranch.filter((b) => b.ageing > 0);
    const branchBlock = branch.length
      ? '<div style="border-top:1px solid var(--hairline);margin:16px 0 12px"></div>' +
        '<h3 class="sub-h">Ageing kit by branch (past 80% of life)</h3>' +
        '<div class="bars">' + branch.map((b) =>
          '<div class="bar-row"><div class="bar-top"><span class="lbl">' + esc(b.location) + '</span><span>' + b.ageing + " of " + b.total + "</span></div>" +
          '<div class="bar-track"><div class="bar-fill" data-w="' + ((b.ageing / Math.max(1, b.total)) * 100) + '" style="width:0;background:#dc2626"></div></div></div>'
        ).join("") + "</div>"
      : "";

    const caveats = [];
    if (fa.missingPriceTotal) caveats.push(fa.missingPriceTotal + " assets have no purchase price, so every cost here is a floor");
    if (fa.missingDateTotal) caveats.push(fa.missingDateTotal + " have no purchase date and sit in “No purchase date”");
    const note = '<p style="font-size:.72rem;color:var(--muted);margin:10px 0 0;line-height:1.5">' +
      "Useful life drives these bands and is set per asset type in Admin. Age is not condition: treat this as a prompt to look, not a decision to buy. Costs are original purchase price, not today’s replacement price." +
      (caveats.length ? "<br>" + esc(caveats.join(". ")) + "." : "") + "</p>";

    return panel(bandBars +
      '<div style="border-top:1px solid var(--hairline);margin:16px 0 12px"></div>' +
      '<h3 class="sub-h">Refresh forecast</h3>' + forecastTable +
      branchBlock + note, "Fleet age and refresh", "panel-block");
  }

  // valueIsHtml: only for values this file builds itself (moneyKpi). Anything
  // derived from asset data must stay escaped.
  function kpi(l, v, h, status, extraClass, valueIsHtml) {
    const statusClass = status || "neutral";
    const val = valueIsHtml ? v : esc(v);
    return '<div class="kpi ' + (extraClass || "") + " kpi-" + statusClass + '"><div class="label">' + esc(l) + '</div><div class="value">' + val + "</div>" + (h ? '<div class="hint">' + esc(h) + "</div>" : "") + "</div>";
  }
  function panel(i, t, cls) { return '<div class="panel ' + (cls || "") + '"><h2>' + esc(t) + "</h2>" + i + "</div>"; }
  // Bucket assets by lastVerified age: fresh <=30d, recent <=90d, overdue >90d,
  // never when missing/unparseable. Mirrors the unverified-90d rule in supabase-client.js.
  function verificationBreakdown(items) {
    const b = { fresh: 0, recent: 0, overdue: 0, never: 0 };
    for (const i of items || []) {
      const t = i.lastVerified ? new Date(i.lastVerified).getTime() : NaN;
      if (isNaN(t)) { b.never++; continue; }
      const days = (Date.now() - t) / 86400000;
      if (days <= 30) b.fresh++;
      else if (days <= 90) b.recent++;
      else b.overdue++;
    }
    return b;
  }
  function statusBars(byStatus) {
    // Same bar-list pattern as bars()/verificationBars(), but colored per-row
    // via statusColor() since status carries real semantic meaning (unlike
    // Type/Location/Department, which are one flat color each). Replaces the
    // old donut here — with a heavily skewed split like 147/2/1, a donut's
    // minority slices are too thin to read; a bar list stays legible at any
    // skew, and matches the other three panels in this row.
    const rows = Object.entries(byStatus || {}).sort((a, b) => b[1] - a[1]);
    const total = Math.max(1, rows.reduce((s, [, v]) => s + v, 0));
    return (
      '<div class="bars">' +
      rows
        .map(
          ([k, v]) =>
            '<div class="bar-row"><div class="bar-top"><span class="lbl">' + esc(k) + '</span><span>' + v + " · " + ((v / total) * 100).toFixed(1) + "%</span></div>" +
            '<div class="bar-track"><div class="bar-fill" data-w="' + ((v / total) * 100) + '" style="width:0;background:' + statusColor(k) + '"></div></div></div>',
        )
        .join("") +
      "</div>"
    );
  }
  const _barsData = {}; // key -> {entries, color, max} for the "+N more" dialog
  const MORE_TITLES = { type: "By Type", location: "By Location", department: "By Department" };
  function barRowHtml(k, v, max, color) {
    return '<div class="bar-row"><div class="bar-top"><span class="lbl">' + esc(k) + '</span><span>' + v + "</span></div>" +
      '<div class="bar-track"><div class="bar-fill" data-w="' + ((v / max) * 100) + '" style="width:0;background:' + color + '"></div></div></div>';
  }
  function bars(obj, color, visibleCount, key) {
    // Cap at 6 visible rows by default -- with up to 10 distinct types/
    // locations/departments, these panels were driving the whole grid row's
    // height (and stretching their shorter row-mate along with them, since
    // CSS Grid rows share height regardless of align-items). Rest go behind
    // a "+N more" button that opens a <dialog> instead of expanding inline
    // -- panel height never changes, so no row-height coupling, ever.
    visibleCount = visibleCount || 6;
    const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...e.map((x) => x[1]));
    const restCount = Math.max(0, e.length - visibleCount);
    if (key) _barsData[key] = { entries: e, color, max };
    const more = restCount
      ? '<button type="button" class="btn-quiet bars-more-btn" onclick="showMoreBars(\'' + key + '\')">+' + restCount + " more</button>"
      : "";
    return '<div class="bars">' + e.slice(0, visibleCount).map(([k, v]) => barRowHtml(k, v, max, color)).join("") + more + "</div>";
  }
  window.showMoreBars = function (key) {
    const d = _barsData[key];
    const dlg = document.getElementById("moreDialog");
    if (!d || !dlg) return;
    document.getElementById("moreDialogTitle").textContent = MORE_TITLES[key] || "All";
    document.getElementById("moreDialogBody").innerHTML =
      '<div class="bars">' + d.entries.map(([k, v]) => barRowHtml(k, v, d.max, d.color)).join("") + "</div>";
    dlg.showModal();
    // dialog rows start at width:0 like the live panels -- animate them in too
    requestAnimationFrame(() => {
      dlg.querySelectorAll(".bar-fill").forEach((el) => { el.style.width = (el.getAttribute("data-w") || "0") + "%"; });
    });
  };
  function verificationBars(v) {
    // Fixed four-bucket freshness view; per-row colors unlike bars().
    const rows = [
      ["Verified \u226430d", v.fresh, "#16a34a"],
      ["31\u201390d", v.recent, "#d97706"],
      ["Overdue 90d+", v.overdue, "#dc2626"],
      ["Never verified", v.never, "#991b1b"],
    ];
    const total = Math.max(1, v.fresh + v.recent + v.overdue + v.never);
    return (
      '<div class="bars">' +
      rows
        .map(
          ([k, n, c]) =>
            '<div class="bar-row"><div class="bar-top"><span class="lbl">' + esc(k) + '</span><span>' + n + "</span></div>" +
            '<div class="bar-track"><div class="bar-fill" data-w="' + ((n / total) * 100) + '" style="width:0;background:' + c + '"></div></div></div>',
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
    const head = "<tr><th>Tag</th><th>Type</th><th>Model</th><th>Serial</th><th>Employee</th><th>Location</th><th>Status</th><th>Purchased</th><th>Price</th><th>Book Value (KES)</th><th>Depreciation Status</th></tr>";
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
    ].map(csvCell).join(","));
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

  // ---------- Monthly depreciation export (accounting periods) ----------
  // Straight-line monthly charge: price ÷ useful life ÷ 12, pro-rated from
  // the purchase month. Fully-depreciated and zero-price assets contribute 0.
  function monthlyCharge(i) {
    if (!(i.purchasePrice > 0) || !(i.usefulLife > 0)) return 0;
    if (!i.purchaseDate) return i.purchasePrice / i.usefulLife / 12;   // best effort: no proration
    const d = new Date(i.purchaseDate + "T00:00:00");
    if (isNaN(d.getTime())) return i.purchasePrice / i.usefulLife / 12;
    const now = new Date();
    const monthsOld = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (monthsOld >= i.usefulLife * 12) return 0;
    return i.purchasePrice / i.usefulLife / 12;
  }
  function exportDepreciationCsv() {
    if (!lastItems.length) return;
    const period = new Date();
    const periodStr = period.getFullYear() + "-" + String(period.getMonth() + 1).padStart(2, "0");
    const headers = [
      "Asset Tag", "Type", "Model", "Serial", "Employee", "Location", "Status",
      "Purchase Date", "Purchase Cost", "Useful Life (Years)", "Useful Life (Months)",
      "Monthly Depreciation", "Depreciation This Year of Service", "Accumulated Depreciation",
      "Closing Book Value", "Depreciation Status"
    ];
    let totMonth = 0, totYtd = 0, totAccum = 0, totBook = 0;
    const rows = lastItems.map(i => {
      const monthly = Math.round(monthlyCharge(i) * 100) / 100;
      const d = i.purchaseDate ? new Date(i.purchaseDate + "T00:00:00") : null;
      let ytd = 0, accum = 0;
      if (d && !isNaN(d.getTime()) && i.purchasePrice > 0 && i.usefulLife > 0) {
        // Accumulated is derived from the same enrichAsset() book value the
        // rest of the app shows, so Cost - Accumulated == Closing Book Value
        // on every row. It used to be counted in whole months while the book
        // value came from fractional-year ageing, so the two never tied and
        // the sheet failed to reconcile against the dashboard.
        accum = Math.round((i.purchasePrice - i.bookValue) * 100) / 100;
        const annual = i.purchasePrice / i.usefulLife;
        const yearsCompleted = i.ageYears !== null && i.ageYears !== undefined ? Math.floor(i.ageYears) : 0;
        ytd = Math.max(0, Math.min(accum, Math.round((accum - yearsCompleted * annual) * 100) / 100));
      }
      totMonth += monthly; totYtd += ytd; totAccum += accum; totBook += i.bookValue;
      return [
        i.tag, i.type, i.model, i.serial, i.employee, i.location, i.status,
        i.purchaseDate || "", i.purchasePrice || "", i.usefulLife || "", (i.usefulLife || 0) * 12,
        monthly.toFixed(2), ytd.toFixed(2), accum.toFixed(2),
        (Math.round(i.bookValue * 100) / 100).toFixed(2), i.depStatus
      ].map(csvCell).join(",");
    });
    const totalsRow = [
      "TOTAL", "", "", "", "", "", "", "", "", "", "",
      totMonth.toFixed(2), totYtd.toFixed(2), totAccum.toFixed(2), (Math.round(totBook * 100) / 100).toFixed(2), ""
    ].map(v => '"' + v + '"').join(",");
    const csv = [
      '"Depreciation Schedule - Period ' + periodStr + ' (generated ' + new Date().toISOString().slice(0, 10) + ')"',
      headers.join(","),
      ...rows,
      totalsRow
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "depreciation-" + periodStr + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // ---------- Boot ----------
  initAuth().catch(e => {
    console.error(e);
    const b = document.getElementById("boot");
    if (b) { b.classList.add("done"); setTimeout(() => b.remove(), 300); }
    showSignIn("Sign-in check failed — please reload.");
  });
})();






