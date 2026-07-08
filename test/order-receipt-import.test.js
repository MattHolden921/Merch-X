"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const receiptImport = require("../public/order-receipt-import");

test("parses warehouse receipt reports by header label when columns move", () => {
  const parsed = receiptImport.parseWarehouseReceiptRows([
    ["Ignore", "this"],
    ["Description", "Qty Received", "Pre-Advice ID", "Qty Due", "SKU"],
    ["Dress Yellow", 15, "PO-2026-0013", 16, "15129"],
    ["Dress Blue", 14, "PO-2026-0013", 16, "15130"]
  ]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.headerRow, 2);
  assert.deepEqual(parsed.references, ["PO-2026-0013"]);
  assert.deepEqual(parsed.lines.map(line => ({
    sku: line.sku,
    dueQuantity: line.dueQuantity,
    receivedQuantity: line.receivedQuantity,
    acceptedQuantity: line.acceptedQuantity
  })), [
    { sku: "15129", dueQuantity: 16, receivedQuantity: 15, acceptedQuantity: 15 },
    { sku: "15130", dueQuantity: 16, receivedQuantity: 14, acceptedQuantity: 14 }
  ]);
});

test("treats blank received cells on SKU rows as zero received", () => {
  const parsed = receiptImport.parseWarehouseReceiptRows([
    ["Pre-Advice ID", "SKU", "Description", "Qty Due", "Qty Received"],
    ["PO-2026-0013", "15161", "Isolde Botanical Print Linen Top", 16, ""]
  ]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].receivedQuantity, 0);
  assert.equal(parsed.lines[0].acceptedQuantity, 0);
  assert.equal(parsed.totals.receivedQuantity, 0);
});

test("sums duplicate SKU rows from a warehouse report", () => {
  const parsed = receiptImport.parseWarehouseReceiptRows([
    ["SKU", "Qty Received", "Qty Damaged"],
    ["'15129", 10, 1],
    [15129, 5, 0]
  ]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].normalizedSku, "15129");
  assert.equal(parsed.lines[0].receivedQuantity, 15);
  assert.equal(parsed.lines[0].damagedQuantity, 1);
  assert.equal(parsed.lines[0].acceptedQuantity, 14);
});
