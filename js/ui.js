// Shared UI helpers for Xana pages (browser global `XanaUI`).
// Single canonical implementation of the display helpers that were
// copy-pasted across index.html, assets/index.html, admin/index.html and
// summary/app.js. Pages alias what they need (e.g. `const { esc } = XanaUI`)
// so call sites stay unchanged.
//
// Deliberately NOT unified here: statusColor.
//   - summary/app.js uses exact-key STATUS_COLORS (dashboard semantics;
//     unknown statuses fall back to blue).
//   - assets/index.html and scanner-app/logic.js use substring matching
//     ("In Repair" and legacy "Under Repair"/"Broken" all read red).
// Merging those would silently recolor pills. Each keeps its own map;
// see also docs/decisions for why dashboard and register differ.
(function () {
  "use strict";

  var CURRENCY = "KES";

  // HTML-escape for interpolated asset data. Null-safe: null/undefined -> "".
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Grouped money, e.g. "KES 4,233,750". Handles null (-> 0) and negatives
  // (-> "KES -5"). Superset of the older assets-page variant.
  function money(n, currency) {
    var cur = currency || CURRENCY;
    var v = n == null ? 0 : n;
    return cur + " " + (v < 0 ? "-" : "") + Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // KPI-sized money: currency becomes a small muted prefix so the number
  // leads and the pair never wraps. Value is built by this file, hence HTML.
  function moneyKpi(n, currency) {
    var full = money(n, currency);
    var sp = full.indexOf(" ");
    if (sp < 0) return esc(full);
    return '<span class="cur">' + esc(full.slice(0, sp)) + "</span>" + esc(full.slice(sp + 1));
  }

  var CSV_DQ = String.fromCharCode(34);
  var CSV_TICK = String.fromCharCode(39);
  // Explicit list, not a character class: "[=+-@]" reads + to @ as a RANGE,
  // which swallows every digit and would prefix every number in the export.
  var CSV_RISKY = ["=", "+", "-", "@", String.fromCharCode(9), String.fromCharCode(13)];

  // CSV cell that cannot execute as a spreadsheet formula (=, +, -, @, tab).
  // Identical to scanner-app/logic.js csvCell (kept there too: logic.js is
  // Node-compatible and covered by unit tests; this copy serves pages).
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (CSV_RISKY.indexOf(s.charAt(0)) > -1) s = CSV_TICK + s;
    return CSV_DQ + s.split(CSV_DQ).join(CSV_DQ + CSV_DQ) + CSV_DQ;
  }

  window.XanaUI = {
    CURRENCY: CURRENCY,
    esc: esc,
    money: money,
    moneyKpi: moneyKpi,
    csvCell: csvCell,
  };
})();
