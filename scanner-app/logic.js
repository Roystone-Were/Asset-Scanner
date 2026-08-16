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
    if (v === undefined || v === null) return "N/A";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const s = Object.values(v).join(", ");
      return s !== "" ? s : "N/A";
    }
    const s = String(v);
    return s !== "" ? s : "N/A";
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
  // an untrimmed stored value would silently miss a scan. There is
  // deliberately NO Barcode column: the barcode on an asset label encodes
  // the tag itself (or the serial), so tag/serial matching covers scans.
  function matchFields(f, clean) {
    for (const key of Object.keys(f || {})) {
      const k = key.toLowerCase().replace(/[^a-z]/g, "");
      const isKey =
        k === "assettag" ||
        k === "title" ||
        k === "serialnumber" ||
        k === "serial";
      if (isKey && String(f[key]).toLowerCase().trim() === clean) return key;
    }
    return null;
  }

  // Candidate values (titles/tags/serials) from a fields object, for
  // fuzzy "did you mean" suggestions.
  function collectCandidates(fields) {
    const out = [];
    for (const key of Object.keys(fields || {})) {
      const k = key.toLowerCase().replace(/[^a-z]/g, "");
      const isKey =
        k === "assettag" ||
        k === "title" ||
        k === "serialnumber" ||
        k === "serial";
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

  // Merge incoming [{id, fields}] into an existing cached item list by id
  // (string-compared): incoming field values win, new items are appended.
  // Used by the offline data cache - a partial refresh (one matched item, a
  // field patch) updates the cache without a full refetch.
  function mergeItems(existing, incoming) {
    const out = [];
    const index = new Map();
    for (const it of existing || []) {
      const k = String(it.id);
      if (index.has(k)) continue;
      index.set(k, out.length);
      out.push({ id: it.id, fields: Object.assign({}, it.fields) });
    }
    for (const it of incoming || []) {
      const k = String(it.id);
      if (index.has(k)) {
        const i = index.get(k);
        out[i].fields = Object.assign({}, out[i].fields, it.fields);
      } else {
        index.set(k, out.length);
        out.push({ id: it.id, fields: Object.assign({}, it.fields) });
      }
    }
    return out;
  }

  // Add a write to the offline sync queue, merging patches that target the
  // same item (later field values win) and capping the queue length (oldest
  // whole entries drop off the front).
  function enqueueWrite(queue, entry, max) {
    const cap = max || 50;
    const q = [];
    let merged = false;
    for (const e of queue || []) {
      if (String(e.id) === String(entry.id)) {
        q.push({ id: e.id, patch: Object.assign({}, e.patch, entry.patch), ts: entry.ts });
        merged = true;
      } else {
        q.push(e);
      }
    }
    if (!merged) q.push({ id: entry.id, patch: Object.assign({}, entry.patch), ts: entry.ts });
    return q.length > cap ? q.slice(q.length - cap) : q;
  }

  // USB "wedge" scanners type their barcode as one fast burst of keystrokes
  // ending in Enter. Classify a recorded key sequence: printable chars plus a
  // final Enter, with every gap under maxGap (default 80ms - far faster than
  // a human sustains over minLen characters).
  function classifyKeyBurst(keys, opts) {
    const maxGap = (opts && opts.maxGap) || 80;
    const minLen = (opts && opts.minLen) || 3;
    if (!keys || keys.length < 2) return { text: "", isScan: false };
    if (keys[keys.length - 1].key !== "Enter") return { text: "", isScan: false };
    const text = keys
      .filter(function (k) { return k.key && k.key.length === 1; })
      .map(function (k) { return k.key; })
      .join("")
      .trim();
    if (text.length < minLen) return { text: text, isScan: false };
    for (let i = 1; i < keys.length; i++) {
      if (keys[i].t - keys[i - 1].t > maxGap) return { text: text, isScan: false };
    }
    return { text: text, isScan: true };
  }

  // "#98" -> "98": a direct asset-number lookup, so a row with no tag and
  // no serial is still findable. Only an explicit "#<digits>" counts -
  // bare numbers stay unmatched (they could be serial fragments).
  function parseIdQuery(s) {
    const m = String(s || "").trim().match(/^#(\d+)$/);
    return m ? m[1] : null;
  }

  // "39,98,23" (also space/semicolon separated, # optional per token) ->
  // ["39","98","23"]: a BATCH asset-number lookup. Requires 2+ tokens that
  // are ALL numbers - a single bare number is still not a lookup, and any
  // non-numeric token means the user is searching something else.
  function parseIdListQuery(s) {
    const raw = String(s || "").trim();
    if (!raw) return null;
    const tokens = raw.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length < 2) return null;
    const ids = [];
    for (const t of tokens) {
      const m = t.match(/^#?(\d+)$/);
      if (!m) return null;
      ids.push(m[1]);
    }
    return ids;
  }

  // Columns the history view diffs between two item versions, as
  // [internal/display-ish name, label]. fieldV() tolerates the display-name
  // variants Graph may return for each.
  const HISTORY_FIELDS = [
    ["Title", "Tag"],
    ["SerialNumber", "Serial"],
    ["Asset", "Asset Type"],
    ["Model", "Model"],
    ["Department", "Department"],
    ["EmployeeName", "Employee"],
    ["Status", "Status"],
    ["Location", "Location"],
    ["Region", "Region"],
    ["Condition", "Condition"],
    ["LastVerified", "Last Verified"],
    ["LastVerifiedBy", "Verified By"],
  ];

  // Diff two item field snapshots: returns [{key, label, from, to}] for
  // tracked columns whose value changed (blank vs missing both read as "").
  // key is the normalized name - callers treat a diff where every key is
  // lastverified/lastverifiedby as "just a verification scan".
  function diffFields(prev, next) {
    const out = [];
    for (const pair of HISTORY_FIELDS) {
      const from = fieldV(prev || {}, pair[0]);
      const to = fieldV(next || {}, pair[0]);
      const fs = from === undefined || from === null ? "" : String(from);
      const ts = to === undefined || to === null ? "" : String(to);
      if (fs !== ts) out.push({ key: pair[0].toLowerCase(), label: pair[1], from: fs || "N/A", to: ts || "N/A" });
    }
    return out;
  }

  // People/offboarding view: group cached items by Employee Name
  // (case-insensitive, trimmed; blank names skipped). Returns
  // [{name, count}] sorted by count desc, then name.
  function groupEmployees(items) {
    const map = new Map();
    for (const it of items || []) {
      const raw = String(fieldV(it.fields || {}, "Employee Name") || "").trim();
      if (!raw) continue;
      const k = raw.toLowerCase();
      if (!map.has(k)) map.set(k, { name: raw, count: 0 });
      map.get(k).count++;
    }
    return Array.from(map.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  }

  // All items assigned to one employee (same normalization as
  // groupEmployees, so a chip from the list always finds its rows).
  function assetsOfEmployee(items, name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return [];
    return (items || []).filter(
      (it) =>
        String(fieldV(it.fields || {}, "Employee Name") || "")
          .trim()
          .toLowerCase() === n,
    );
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
    mergeItems,
    enqueueWrite,
    classifyKeyBurst,
    diffFields,
    groupEmployees,
    assetsOfEmployee,
    parseIdQuery,
    parseIdListQuery,
    STATUS_CHOICES,
    LOCATION_CHOICES,
    REGION_CHOICES,
    findDuplicateSerials,
  };
});
