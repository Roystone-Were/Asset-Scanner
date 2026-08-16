"use strict";
// Golden tests: assert real-world facts about the actual Xana Asset Inventory
// list (scanner-app/test/fixtures/assets.json), exported by Export-AssetsJson.ps1.
// After bulk changes to the list, re-run that script and commit the new fixture.
const { test } = require("node:test");
const assert = require("node:assert");
const X = require("../logic.js");
const rows = require("./fixtures/assets.json");

// Synthesize the Graph-style fields object the app matches against.
function fieldsOf(row) {
  const f = {
    Title: row.tag,
    SerialNumber: row.serial,
    Asset: row.assetType, // Asset Type column (internal name 'Asset')
  };
  return f;
}

test("golden: fixture is the real exported list (non-empty, unique ascending ids)", () => {
  assert.ok(
    rows.length > 0,
    "fixture must not be empty - re-run Export-AssetsJson.ps1",
  );
  const ids = rows.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, "asset ids must be unique");
  assert.ok(
    ids.every((v, i) => i === 0 || ids[i - 1] < v),
    "ids must be sorted ascending",
  );
});

test("golden: MICL0045 resolves to Asset #1 (the real lookup)", () => {
  const row = rows.find((r) => r.tag === "MICL0045");
  assert.ok(row, "MICL0045 must exist in the fixture");
  assert.strictEqual(row.id, 1);
  assert.strictEqual(X.matchFields(fieldsOf(row), "micl0045"), "Title");
  assert.strictEqual(X.matchFields(fieldsOf(row), "pw0mggla"), "SerialNumber");
});

test("golden: every tag and serial resolves back to exactly one asset", () => {
  // The lookup must never be ambiguous: no two assets may share a tag or
  // serial. This fails the moment duplicate serials come back into the list
  // (they were fixed once already, but the list is the product).
  const map = new Map();
  for (const r of rows) {
    for (const v of [r.tag, r.serial]) {
      const key = String(v || "").trim().toUpperCase();
      if (!key) continue;
      assert.ok(
        !map.has(key),
        "duplicate lookup value '" + key + "' across assets",
      );
      map.set(key, r.id);
    }
  }
});

test("golden: 'LAPTOP' never matches (Asset Type is excluded from lookup)", () => {
  for (const r of rows) {
    assert.strictEqual(X.matchFields(fieldsOf(r), "laptop"), null);
  }
});

test("golden: tags and serials are unpadded so scans can match", () => {
  for (const r of rows) {
    if (r.serial)
      assert.strictEqual(
        r.serial,
        r.serial.trim(),
        "padded serial on asset #" + r.id,
      );
    if (r.tag)
      assert.strictEqual(r.tag, r.tag.trim(), "padded tag on asset #" + r.id);
  }
});

test("golden: findDuplicateSerials reports nothing on the current list", () => {
  assert.deepStrictEqual(X.findDuplicateSerials(rows), []);
});

test("golden: every asset round-trips through the app's matcher", () => {
  for (const r of rows) {
    const f = fieldsOf(r);
    if (r.tag)
      assert.strictEqual(
        X.matchFields(f, r.tag.toLowerCase()),
        "Title",
        "asset #" + r.id,
      );
    if (r.serial)
      assert.strictEqual(
        X.matchFields(f, r.serial.toLowerCase()),
        "SerialNumber",
        "asset #" + r.id,
      );
  }
});
