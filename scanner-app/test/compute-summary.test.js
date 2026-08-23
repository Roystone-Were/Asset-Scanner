"use strict";
// Tests for js/supabase-client.js computeSummary — runs the adapter in a
// minimal DOM-less harness: supabase-js is not loaded, but computeSummary
// only touches pure helpers (createClient is never invoked by it).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadAdapter() {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "..", "js", "supabase-client.js"),
    "utf8",
  );
  const sandboxWindow = {};
  const fn = new Function("window", "navigator", "localStorage", "location", code);
  fn(sandboxWindow,
     { onLine: true },
     { getItem: () => null, setItem: () => {}, removeItem: () => {} },
     { hash: "", pathname: "/", search: "" });
  return sandboxWindow.XanaSupabase;
}

test("computeSummary separates estimate-pending book value", () => {
  const XanaSupabase = loadAdapter();
  const items = [
    { tag:"A", purchasePrice:1000, bookValue:800, depStatus:"In progress", usefulLife:3, type:"Laptop", estimatePending:false },
    { tag:"B", purchasePrice:500,  bookValue:400, depStatus:"In progress", usefulLife:3, type:"Laptop", estimatePending:true },
    { tag:"C", purchasePrice:2000, bookValue:1500, depStatus:"In progress", usefulLife:4, type:"Desktop", estimatePending:true },
  ];
  const s = XanaSupabase.computeSummary(items);
  assert.strictEqual(s.totals.confirmedBookValue, 800);
  assert.strictEqual(s.totals.estimatePendingCount, 2);
  // total book value unchanged by the split
  assert.strictEqual(s.totals.bookValue, 2700);
});

test("computeSummary with zero estimates reports count 0 and full confirmed", () => {
  const XanaSupabase = loadAdapter();
  const items = [
    { tag:"A", purchasePrice:1000, bookValue:800, depStatus:"In progress", usefulLife:3, type:"Laptop", estimatePending:false },
  ];
  const s = XanaSupabase.computeSummary(items);
  assert.strictEqual(s.totals.confirmedBookValue, 800);
  assert.strictEqual(s.totals.estimatePendingCount, 0);
});
