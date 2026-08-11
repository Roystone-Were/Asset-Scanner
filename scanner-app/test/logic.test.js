"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const X = require("../logic.js");

test("cleanScanInput strips vendor barcode prefixes", () => {
  assert.strictEqual(
    X.cleanScanInput("METROCARE IMAGING CENTER LIMITED — MICL0045"),
    "MICL0045",
  );
  assert.strictEqual(
    X.cleanScanInput("METROCARE IMAGING CENTER LIMITED - MICL0045"),
    "MICL0045",
  );
  assert.strictEqual(X.cleanScanInput("VENDOR: 4CE543BWTT"), "4CE543BWTT");
});

test("cleanScanInput uppercases and trims", () => {
  assert.strictEqual(X.cleanScanInput("  micl0045  "), "MICL0045");
});

test("cleanScanInput preserves mid-code hyphens", () => {
  assert.strictEqual(X.cleanScanInput("CN-09094X"), "CN-09094X");
  assert.strictEqual(X.cleanScanInput("9cp536240y"), "9CP536240Y");
});

test("matchFields matches lookup columns only", () => {
  const f = {
    Title: "MICL0045",
    SerialNumber: "PW0MGGLA",
    Barcode: "VENDOR-99",
    Asset: "Laptop",
  };
  assert.strictEqual(X.matchFields(f, "micl0045"), "Title");
  assert.strictEqual(X.matchFields(f, "pw0mggla"), "SerialNumber");
  // Registered barcodes are matchable too (register-on-scan target).
  assert.strictEqual(X.matchFields(f, "vendor-99"), "Barcode");
  // Asset (Asset Type) must NOT be matchable - typing "Laptop" is not a scan.
  assert.strictEqual(X.matchFields(f, "laptop"), null);
});

test("matchFields returns null for empty fields", () => {
  assert.strictEqual(X.matchFields(null, "micl0045"), null);
  assert.strictEqual(X.matchFields({}, "micl0045"), null);
});

test("fieldV tolerates internal-name variants", () => {
  assert.strictEqual(X.fieldV({ Asset_x0020_Type: "Laptop" }, "Asset Type"), "Laptop");
  assert.strictEqual(X.fieldV({ AssetType: "Laptop" }, "Asset Type"), "Laptop");
  assert.strictEqual(X.fieldV({ "Employee_x0020_Name": "Roy" }, "Employee Name"), "Roy");
});

test("fieldV does not match the renamed 'Asset' column", () => {
  // "Asset Type" has internal name Asset (column was renamed); the app
  // handles it with an explicit fieldV(item, "Asset") fallback at the call site.
  assert.strictEqual(X.fieldV({ Asset: "Laptop" }, "Asset Type"), undefined);
  assert.strictEqual(X.fieldV({ Model: "Lenovo L13" }, "Asset Type"), undefined);
});

test("g renders strings, lookup objects, and empty values", () => {
  assert.strictEqual(X.g("MICL0045"), "MICL0045");
  assert.strictEqual(X.g({ description: "A", lookupId: 1 }), "A, 1");
  assert.strictEqual(X.g(null), "—");
  assert.strictEqual(X.g(undefined), "—");
});

test("statusColor maps statuses", () => {
  assert.strictEqual(X.statusColor("Lost"), "#c50f1f");
  assert.strictEqual(X.statusColor("Under Repair"), "#d13438");
  assert.strictEqual(X.statusColor("In Use"), "#107c10");
  assert.strictEqual(X.statusColor("Retired"), "#605e5c");
  assert.strictEqual(X.statusColor("Left With"), "#5c2d91");
  assert.strictEqual(X.statusColor("Available"), "#ff8c00");
});

test("escapeHtml escapes specials", () => {
  assert.strictEqual(
    X.escapeHtml('<b a="x">'),
    "&lt;b a=&quot;x&quot;&gt;",
  );
});

test("levenshtein distances", () => {
  assert.strictEqual(X.levenshtein("MICL0045", "MICL0045"), 0);
  assert.strictEqual(X.levenshtein("MICL0045", "MICL0046"), 1);
  assert.strictEqual(X.levenshtein("", "ABC"), 3);
  assert.strictEqual(X.levenshtein("ABC", ""), 3);
});

test("suggestMatch suggests close values and rejects far ones", () => {
  const cands = ["MICL0045", "PW0MGGLA", "4CE543BWTT"];
  assert.strictEqual(X.suggestMatch("micl0046", cands), "MICL0045");
  assert.strictEqual(X.suggestMatch("micl0045", cands), "MICL0045");
  assert.strictEqual(X.suggestMatch("ZZZZZZZZ", cands), null);
  assert.strictEqual(X.suggestMatch("", cands), null);
});

test("collectCandidates gathers lookup values only", () => {
  const f = {
    Title: "MICL0045",
    SerialNumber: "PW0MGGLA",
    Barcode: "VENDOR-99",
    Asset: "Laptop", // excluded - not a lookup column
    Model: "Lenovo L13", // excluded
  };
  const c = X.collectCandidates(f);
  assert.deepStrictEqual(c.sort(), ["MICL0045", "PW0MGGLA", "VENDOR-99"]);
});

test("findDuplicateSerials flags serials on multiple rows", () => {
  const rows = [
    { id: 1, serial: "A1" },
    { id: 2, serial: "a1" },
    { id: 3, serial: "B2" },
    { id: 4, serial: "  B2 " },
    { id: 5, serial: "" },
    { id: 6, serial: null },
  ];
  assert.deepStrictEqual(X.findDuplicateSerials(rows), [
    { serial: "A1", ids: [1, 2] },
    { serial: "B2", ids: [3, 4] },
  ]);
});

test("findDuplicateSerials handles empty lists and blank serials", () => {
  assert.deepStrictEqual(X.findDuplicateSerials([]), []);
  assert.deepStrictEqual(
    X.findDuplicateSerials([{ id: 1, serial: "" }, { id: 2 }]),
    [],
  );
});

test("choice constants match the SharePoint columns", () => {
  assert.deepStrictEqual(X.STATUS_CHOICES, [
    "In Use",
    "Available",
    "Retired",
    "Left With",
    "Lost",
  ]);
  assert.ok(X.LOCATION_CHOICES.includes("Syokimau"));
  assert.ok(X.LOCATION_CHOICES.includes("TRM Dr"));
  assert.ok(X.REGION_CHOICES.includes("Nairobi"));
});

test("filterHistory expires old entries and keeps legacy strings", () => {
  const now = Date.now();
  const ttl = 24 * 60 * 60 * 1000;
  const raw = [
    { c: "OLD", t: now - 25 * 3600 * 1000 },
    { c: "FRESH", t: now - 1000 },
    "LEGACY",
    null,
    { c: "NOSET" },
  ];
  const out = X.filterHistory(raw, now, ttl);
  assert.deepStrictEqual(
    out.map((e) => e.c),
    ["FRESH", "LEGACY", "NOSET"],
  );
});
