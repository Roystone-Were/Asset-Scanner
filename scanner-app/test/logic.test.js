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

test("matchFields matches tag/serial columns only", () => {
  const f = {
    Title: "MICL0045",
    SerialNumber: "PW0MGGLA",
    Asset: "Laptop",
  };
  assert.strictEqual(X.matchFields(f, "micl0045"), "Title");
  assert.strictEqual(X.matchFields(f, "pw0mggla"), "SerialNumber");
  // There is no Barcode column: a stray stored barcode value must NOT match
  // (label barcodes encode the tag or serial, which match via Title/Serial).
  assert.strictEqual(X.matchFields({ Barcode: "VENDOR-99" }, "vendor-99"), null);
  // Asset (Asset Type) must NOT be matchable - typing "Laptop" is not a scan.
  assert.strictEqual(X.matchFields(f, "laptop"), null);
});

test("matchFields trims stored values so trailing spaces can't miss", () => {
  // SharePoint rust: "4P09PF3 " with a trailing space must still match a scan.
  assert.strictEqual(
    X.matchFields({ SerialNumber: "PW0MGGLA " }, "pw0mggla"),
    "SerialNumber",
  );
  assert.strictEqual(
    X.matchFields({ Title: " MICL0045 " }, "micl0045"),
    "Title",
  );
  // Padding still can't make a non-match match.
  assert.strictEqual(X.matchFields({ SerialNumber: "PW0MGGLAX " }, "pw0mggla"), null);
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
  assert.strictEqual(X.g(null), "N/A");
  assert.strictEqual(X.g(undefined), "N/A");
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
    Asset: "Laptop", // excluded - not a lookup column
    Model: "Lenovo L13", // excluded
  };
  const c = X.collectCandidates(f);
  assert.deepStrictEqual(c.sort(), ["MICL0045", "PW0MGGLA"]);
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

test("mergeItems updates by id (string-compared) and appends new items", () => {
  const existing = [
    { id: 1, fields: { Title: "MICL0045", Status: "In Use" } },
    { id: 2, fields: { Title: "MICL0046" } },
  ];
  const out = X.mergeItems(existing, [
    { id: "1", fields: { Status: "Lost" } }, // number-vs-string id still matches
    { id: 3, fields: { Title: "MICL0047" } },
  ]);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out[0].fields, { Title: "MICL0045", Status: "Lost" });
  assert.deepStrictEqual(out[1].fields, { Title: "MICL0046" });
  assert.deepStrictEqual(out[2].fields, { Title: "MICL0047" });
  // Inputs are not mutated (the cache must stay immutable-ish).
  assert.deepStrictEqual(existing[0].fields, {
    Title: "MICL0045",
    Status: "In Use",
  });
});

test("mergeItems tolerates empty inputs", () => {
  assert.deepStrictEqual(X.mergeItems([], []), []);
  assert.strictEqual(X.mergeItems(null, [{ id: 1, fields: { A: 1 } }]).length, 1);
  assert.strictEqual(X.mergeItems([{ id: 1, fields: {} }], null).length, 1);
});

test("enqueueWrite merges patches for the same item, later values win", () => {
  const q1 = X.enqueueWrite([], { id: 7, patch: { Status: "Lost" }, ts: 1 });
  const q2 = X.enqueueWrite(q1, { id: "7", patch: { Location: "Ruiru" }, ts: 2 });
  assert.strictEqual(q2.length, 1);
  assert.deepStrictEqual(q2[0].patch, { Status: "Lost", Location: "Ruiru" });
  assert.strictEqual(q2[0].ts, 2);
});

test("enqueueWrite keeps distinct items apart and caps the queue", () => {
  let q = X.enqueueWrite([], { id: 1, patch: { LastVerified: "a" }, ts: 1 });
  q = X.enqueueWrite(q, { id: 2, patch: { LastVerified: "b" }, ts: 2 });
  assert.strictEqual(q.length, 2);
  // Cap of 3: oldest entries drop off the front.
  q = X.enqueueWrite(q, { id: 3, patch: {}, ts: 3 }, 3);
  q = X.enqueueWrite(q, { id: 4, patch: {}, ts: 4 }, 3);
  assert.deepStrictEqual(q.map((e) => e.id), [2, 3, 4]);
});

test("classifyKeyBurst detects a fast scanner burst ending in Enter", () => {
  const keys = [
    { key: "M", t: 1000 },
    { key: "I", t: 1020 },
    { key: "C", t: 1040 },
    { key: "L", t: 1060 },
    { key: "0", t: 1080 },
    { key: "0", t: 1100 },
    { key: "4", t: 1120 },
    { key: "5", t: 1140 },
    { key: "Enter", t: 1160 },
  ];
  const r = X.classifyKeyBurst(keys);
  assert.strictEqual(r.isScan, true);
  assert.strictEqual(r.text, "MICL0045");
});

test("classifyKeyBurst rejects human typing, short codes, missing Enter", () => {
  // Human-paced gaps (200ms between keys).
  const human = [
    { key: "M", t: 1000 },
    { key: "I", t: 1200 },
    { key: "C", t: 1400 },
    { key: "Enter", t: 1600 },
  ];
  assert.strictEqual(X.classifyKeyBurst(human).isScan, false);
  // Scanner-fast but too short to be a code.
  const short = [
    { key: "A", t: 1000 },
    { key: "B", t: 1010 },
    { key: "Enter", t: 1020 },
  ];
  assert.strictEqual(X.classifyKeyBurst(short).isScan, false);
  // No Enter terminator.
  const noEnter = [
    { key: "M", t: 1000 },
    { key: "I", t: 1010 },
    { key: "C", t: 1020 },
  ];
  assert.strictEqual(X.classifyKeyBurst(noEnter).isScan, false);
  // Mixed non-printables (Shift) are ignored, not counted as text.
  const shifted = [
    { key: "Shift", t: 1000 },
    { key: "M", t: 1005 },
    { key: "I", t: 1015 },
    { key: "C", t: 1025 },
    { key: "L", t: 1035 },
    { key: "Enter", t: 1045 },
  ];
  assert.strictEqual(X.classifyKeyBurst(shifted).text, "MICL");
});

test("findAssetByCode matches tag, serial and #id on enriched rows", () => {
  const items = [
    { id: "1", tag: "MICL0045", serial: "PW0MGGLA" },
    { id: "2", tag: "XL-7", serial: "MXL2153DKN" },
  ];
  assert.strictEqual(X.findAssetByCode(items, "micl0045").id, "1");
  assert.strictEqual(X.findAssetByCode(items, " MICL0045 ").id, "1");
  assert.strictEqual(X.findAssetByCode(items, "mxl2153dkn").id, "2");
  assert.strictEqual(X.findAssetByCode(items, "#2").id, "2");
  assert.strictEqual(X.findAssetByCode(items, "METROCARE IMAGING — MICL0045").id, "1");
  assert.strictEqual(X.findAssetByCode(items, "nope"), null);
  assert.strictEqual(X.findAssetByCode(items, ""), null);
});

test("groupPeopleEnriched groups enriched rows and skips blanks", () => {
  const items = [
    { id: "1", employee: "Ada Kim" },
    { id: "2", employee: "  ada kim " },
    { id: "3", employee: "Ben Ochieng" },
    { id: "4", employee: "" },
    { id: "5", employee: null },
  ];
  const groups = X.groupPeopleEnriched(items);
  assert.deepStrictEqual(groups.map(g => [g.name, g.count, g.ids]), [
    ["Ada Kim", 2, ["1", "2"]],
    ["Ben Ochieng", 1, ["3"]],
  ]);
});

test("diffFields reports tracked column changes with labels", () => {
  const prev = { Title: "MICL0045", Status: "In Use", Location: "Syokimau" };
  const next = { Title: "MICL0045", Status: "Lost", Location: "Syokimau" };
  const d = X.diffFields(prev, next);
  assert.strictEqual(d.length, 1);
  assert.deepStrictEqual(d[0], { key: "status", label: "Status", from: "In Use", to: "Lost" });
});

test("diffFields treats blank and missing as equal, flags blank vs value", () => {
  // Condition "" vs absent -> no change (Status identical on both sides).
  assert.deepStrictEqual(
    X.diffFields({ Condition: "", Status: "In Use" }, { Status: "In Use" }),
    [],
  );
  // Setting a previously-blank value shows up as "N/A" -> value.
  const d = X.diffFields(
    { Title: "MICL0045" },
    { Title: "MICL0045", Condition: "New" },
  );
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].label, "Condition");
  assert.strictEqual(d[0].from, "N/A");
  assert.strictEqual(d[0].to, "New");
});

test("parseIdQuery accepts #<digits> only", () => {
  assert.strictEqual(X.parseIdQuery("#98"), "98");
  assert.strictEqual(X.parseIdQuery(" #98 "), "98");
  assert.strictEqual(X.parseIdQuery("#1"), "1");
  // Bare numbers are NOT id lookups (could be serial fragments).
  assert.strictEqual(X.parseIdQuery("98"), null);
  assert.strictEqual(X.parseIdQuery("#9a"), null);
  assert.strictEqual(X.parseIdQuery("#-1"), null);
  assert.strictEqual(X.parseIdQuery(""), null);
  assert.strictEqual(X.parseIdQuery(null), null);
});

test("parseIdListQuery accepts multi-number batches in any separator", () => {
  assert.deepStrictEqual(X.parseIdListQuery("39,98,23"), ["39", "98", "23"]);
  assert.deepStrictEqual(X.parseIdListQuery("39 98"), ["39", "98"]);
  assert.deepStrictEqual(X.parseIdListQuery("#39, 98;23"), ["39", "98", "23"]);
  assert.deepStrictEqual(X.parseIdListQuery(" 39 ,  98 "), ["39", "98"]);
});

test("parseIdListQuery rejects single numbers and mixed text", () => {
  // A single bare number is not a batch (and not a lookup at all).
  assert.strictEqual(X.parseIdListQuery("98"), null);
  assert.strictEqual(X.parseIdListQuery("#98"), null);
  // Any non-numeric token means this is some other search.
  assert.strictEqual(X.parseIdListQuery("39,MICL0045"), null);
  // A trailing separator is harmless.
  assert.deepStrictEqual(X.parseIdListQuery("39,98,"), ["39", "98"]);
  assert.strictEqual(X.parseIdListQuery(""), null);
  assert.strictEqual(X.parseIdListQuery(null), null);
});

test("diffFields keys let callers spot verification-only versions", () => {
  const prev = { LastVerified: "2026-08-01T10:00:00Z" };
  const next = {
    LastVerified: "2026-08-15T09:00:00Z",
    LastVerifiedBy: "Roystone Were",
  };
  const d = X.diffFields(prev, next);
  assert.ok(d.length > 0);
  assert.ok(d.every((x) => x.key === "lastverified" || x.key === "lastverifiedby"));
});

test("groupEmployees groups by trimmed case-insensitive name", () => {
  const items = [
    { id: 1, fields: { EmployeeName: "Erastus Maina" } },
    { id: 2, fields: { EmployeeName: "erastus maina " } }, // same person
    { id: 3, fields: { EmployeeName: "Roystone Licha" } },
    { id: 4, fields: { EmployeeName: "" } }, // blank - skipped
    { id: 5, fields: { Model: "no employee at all" } },
  ];
  assert.deepStrictEqual(X.groupEmployees(items), [
    { name: "Erastus Maina", count: 2 },
    { name: "Roystone Licha", count: 1 },
  ]);
  assert.deepStrictEqual(X.groupEmployees([]), []);
});

test("assetsOfEmployee matches with the same normalization", () => {
  const items = [
    { id: 1, fields: { EmployeeName: "Erastus Maina", Title: "MICL0045" } },
    { id: 2, fields: { EmployeeName: " erastus MAINA ", Title: "MICL0046" } },
    { id: 3, fields: { EmployeeName: "Someone Else" } },
  ];
  const got = X.assetsOfEmployee(items, "ERASTUS maina");
  assert.deepStrictEqual(got.map((x) => x.id), [1, 2]);
  assert.deepStrictEqual(X.assetsOfEmployee(items, ""), []);
  assert.deepStrictEqual(X.assetsOfEmployee(items, "Nobody"), []);
});
