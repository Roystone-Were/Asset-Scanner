// Xana Asset Lookup - pure logic (no DOM, no storage). Loaded by the app as a
// global `Xana` and by tests via require().
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Xana = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Flatten a field value for display: strings pass through unchanged,
  // SharePoint lookup objects get their values joined.
  function g(v) {
    if (v === undefined || v === null) return "—";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const s = Object.values(v).join(", ");
      return s !== "" ? s : "—";
    }
    const s = String(v);
    return s !== "" ? s : "—";
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function statusColor(status) {
    const s = (status || "").toLowerCase();
    if (s.includes("repair") || s.includes("broken")) return "#d13438";
    if (s.includes("lost")) return "#c50f1f";
    if (s.includes("available")) return "#ff8c00";
    if (s.includes("retired")) return "#605e5c";
    if (s.includes("left")) return "#5c2d91";
    return "#107c10";
  }

  // Normalize a SharePoint field name: decode _xNNNN_ hex escapes (e.g.
  // "Asset_x0020_Type" -> "Asset Type"), lowercase, drop non-alphanumerics.
  function normKey(s) {
    return s
      .toLowerCase()
      .replace(/_x([0-9a-f]{4})_/gi, (m, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/[^a-z0-9]/g, "");
  }

  // Look up a Graph field by display name, tolerating internal-name
  // variations ("Asset Type" may come back as "AssetType" or
  // "Asset_x0020_Type").
  function fieldV(fields, name) {
    const want = normKey(name);
    for (const k of Object.keys(fields || {})) {
      if (normKey(k) === want) return fields[k];
    }
    return undefined;
  }

  // Normalize whatever was scanned or typed: uppercase, trim, and strip
  // vendor barcode prefixes like "METROCARE IMAGING CENTER LIMITED — MICL0045"
  // (a spaced hyphen is treated as a separator too, but mid-code hyphens
  // like CN-09094X are left alone).
  function cleanScanInput(s) {
    let v = String(s || "").trim().toUpperCase();
    const parts = v.split(/[—–]/);
    if (parts.length > 1) v = parts[parts.length - 1].trim();
    else {
      const c = v.split(/:/);
      if (c.length > 1) v = c[c.length - 1].trim();
      else {
        const h = v.split(/\s+-\s+/);
        if (h.length > 1) v = h[h.length - 1].trim();
      }
    }
    return v;
  }

  // Returns the matched field key if `fields` matches the cleaned value
  // against any lookup column, otherwise null. Both sides are trimmed:
  // SharePoint values sometimes carry trailing spaces (e.g. "4P09PF3 "), and
  // an untrimmed stored value would silently miss a scan.
  function matchFields(f, clean) {
    for (const key of Object.keys(f || {})) {
      const k = key.toLowerCase().replace(/[^a-z]/g, "");
      const isKey =
        k === "assettag" ||
        k === "title" ||
        k === "serialnumber" ||
        k === "serial" ||
        k === "barcode";
      if (isKey && String(f[key]).toLowerCase().trim() === clean) return key;
    }
    return null;
  }

  // Candidate values (titles/tags/serials/barcodes) from a fields object, for
  // fuzzy "did you mean" suggestions.
  function collectCandidates(fields) {
    const out = [];
    for (const key of Object.keys(fields || {})) {
      const k = key.toLowerCase().replace(/[^a-z]/g, "");
      const isKey =
        k === "assettag" ||
        k === "title" ||
        k === "serialnumber" ||
        k === "serial" ||
        k === "barcode";
      if (isKey) {
        const v = String(fields[key] || "").trim();
        if (v) out.push(v);
      }
    }
    return out;
  }

  // Edit distance (Levenshtein).
  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = [];
    for (let i = 0; i <= m; i++) {
      dp[i] = [i];
      for (let j = 1; j <= n; j++) dp[i][j] = 0;
    }
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return dp[m][n];
  }

  // Best fuzzy suggestion within threshold (distance <= 2), or null.
  function suggestMatch(input, candidates) {
    const u = String(input || "").toUpperCase().trim();
    if (!u) return null;
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const cv = String(c || "").toUpperCase().trim();
      if (!cv) continue;
      const d = levenshtein(u, cv);
      if (d < bestD) {
        bestD = d;
        best = cv;
      }
    }
    if (best && bestD <= 2) return best;
    return null;
  }

  // SharePoint Choice-column values (ground truth from the list schema). The
  // app's edit dropdowns must only offer these - Choice columns reject values
  // that aren't in the list.
  const STATUS_CHOICES = ["In Use", "Available", "Retired", "Left With", "Lost"];
  const LOCATION_CHOICES = [
    "Syokimau",
    "Katani",
    "Ruiru",
    "Githurai",
    "Lumumba Dr",
    "TRM Dr",
  ];
  const REGION_CHOICES = ["Nairobi", "Kiambu"];

  // Find serial numbers that appear on more than one asset row. `rows` are
  // normalized records ({ id, serial, ... }); returns [{ serial, ids }] sorted.
  function findDuplicateSerials(rows) {
    const seen = new Map();
    for (const r of rows || []) {
      const s = String((r && r.serial) || "").trim().toUpperCase();
      if (!s) continue;
      if (!seen.has(s)) seen.set(s, []);
      seen.get(s).push(r.id);
    }
    const dups = [];
    for (const [serial, ids] of seen) {
      if (ids.length > 1) dups.push({ serial: serial, ids: ids.slice() });
    }
    return dups.sort((a, b) => a.serial.localeCompare(b.serial));
  }

  // Filter history entries to those newer than ttl ms. Legacy string entries
  // (no timestamp) are treated as fresh from `now`.
  function filterHistory(raw, now, ttl) {
    const fresh = [];
    for (const x of raw) {
      if (typeof x === "string") {
        fresh.push({ c: x, t: now });
      } else if (x && typeof x === "object" && x.c) {
        const t = x.t || now;
        if (now - t < ttl) fresh.push({ c: x.c, t: t });
      }
    }
    return fresh;
  }

  return {
    g,
    escapeHtml,
    statusColor,
    normKey,
    fieldV,
    cleanScanInput,
    matchFields,
    collectCandidates,
    levenshtein,
    suggestMatch,
    filterHistory,
    STATUS_CHOICES,
    LOCATION_CHOICES,
    REGION_CHOICES,
    findDuplicateSerials,
  };
});
