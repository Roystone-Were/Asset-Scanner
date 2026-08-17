// summary/test/summary.test.js
// Unit tests for the summary computation (pure logic; no network).
// Run: cd summary && npm install && npm test
const { test } = require("node:test");
const assert = require("node:assert");
const mod = require("../api/summary.js");

const compute = mod.computeSummary;

function item(overrides) {
  return {
    id: 1,
    fields: {
      Title: "Xana001", "Asset Type": "Laptop", Model: "Lenovo L13",
      "Serial Number": "SER1", Department: "IT", Location: "Syokimau",
      Status: "In Use", "Employee Name": "Roystone Licha",
      "Purchase Date": "2024-01-15T00:00:00Z", "Purchase Price": "120000",
      "Useful Life": 3,
      ...overrides,
    },
  };
}

test("computes straight-line book value after ~2 years", () => {
  const past = new Date(Date.now() - 730 * 86400000).toISOString(); // ~2 years ago
  const s = compute([item({ "Purchase Date": past })]);
  const row = s.items[0];
  // 120000 over 3 yrs = 40000/yr; ~2 yrs => ~80000 accum, book ~40000
  assert.ok(Math.abs(row.bookValue - 40000) < 2000, `bookValue=${row.bookValue}`);
  assert.equal(row.depStatus, "In progress");
  assert.equal(s.totals.total, 1);
  assert.ok(s.totals.bookValue > 0);
});

test("flags fully depreciated after useful life", () => {
  const old = new Date(Date.now() - 1400 * 86400000).toISOString(); // > 3 yrs
  const s = compute([item({ "Purchase Date": old })]);
  assert.equal(s.items[0].depStatus, "Fully depreciated");
  assert.equal(s.totals.fullyDepreciated, 1);
});

test("handles missing purchase data without crashing and flags it", () => {
  const s = compute([item({ "Purchase Date": "", "Purchase Price": "" })]);
  assert.equal(s.items[0].depStatus, "No data");
  assert.equal(s.totals.missingPurchase, 1);
  assert.equal(s.dataHealth.missingPurchase, 1);
  assert.equal(s.items[0].bookValue, 0);
});

test("counts byStatus and byType", () => {
  const s = compute([
    item({ Status: "In Use" }),
    item({ Status: "Lost", "Asset Type": "Monitor" }),
  ]);
  assert.equal(s.byStatus["In Use"], 1);
  assert.equal(s.byStatus["Lost"], 1);
  assert.equal(s.byType["Monitor"], 1);
});
