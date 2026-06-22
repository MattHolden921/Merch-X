"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_PAH_SETTINGS, PAH_HEADERS, buildPahReport } = require("../lib/pah-report");

const order = {
  orderNumber: "PO-2026-0015",
  delivery: { requiredDate: "2026-06-24" },
  lines: [
    { style: "Dress, long", sku: "15009", colour: "Pink/Cotton", quantity: 15 },
    { style: "Top", sku: "15010", colour: "Navy/Cotton", quantity: 10 }
  ]
};

test("builds the warehouse PAH contract with CRLF and CSV escaping", () => {
  const result = buildPahReport({ order, settings: DEFAULT_PAH_SETTINGS });
  assert.equal(result.valid, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0][0], "PO-2026-0015");
  assert.equal(result.rows[0][3], "24/06/2026");
  assert.equal(result.rows[0][18], 15);
  assert.match(result.content, /"Dress, long"/);
  assert.equal(result.content.split("\r\n")[0], PAH_HEADERS.join(","));
  assert.equal(result.filename, "PAH PO-2026-0015.csv");
});

test("uses batch allocations, batch ETA, and a unique batch reference", () => {
  const batches = [{ id: "b1", batchNumber: "A", etaDate: "2026-07-01" }];
  const batchLines = [{ batchId: "b1", lineIndex: 1, quantity: 4 }];
  const result = buildPahReport({ order, batches, batchLines, scopeType: "batch", batchId: "b1", settings: DEFAULT_PAH_SETTINGS });
  assert.equal(result.valid, true);
  assert.equal(result.preAdviceId, "PO-2026-0015-A");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0][3], "01/07/2026");
  assert.equal(result.rows[0][18], 4);
});

test("unbatched scope subtracts every allocation and validates dates", () => {
  const batchLines = [{ batchId: "b1", lineIndex: 0, quantity: 5 }, { batchId: "b2", lineIndex: 1, quantity: 10 }];
  const result = buildPahReport({ order, batchLines, scopeType: "unbatched", settings: DEFAULT_PAH_SETTINGS });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0][18], 10);
  const missingDate = buildPahReport({ order: { ...order, delivery: {} }, settings: DEFAULT_PAH_SETTINGS });
  assert.equal(missingDate.valid, false);
  assert.ok(missingDate.errors.some(message => message.includes("ETA warehouse")));
});
