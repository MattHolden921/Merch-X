"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLabelJobSnapshot, normalizeDoubleBarcodeSnapshot } = require("../lib/label-jobs");

const order = {
  orderNumber: "PO-1",
  lines: [
    { sku: "15100", buyingCode: "MIA24", style: "Mia dress", colour: "Navy", size: "S", quantity: 10 },
    { sku: "15101", buyingCode: "MIA24", style: "Mia dress", colour: "Navy", size: "M", quantity: 12 },
    { sku: "15102", buyingCode: "MIA24", style: "Mia dress", colour: "Red", size: "S", quantity: 8 }
  ]
};

test("uses the SKU as Code 128 and supplies two labels per unit plus spares", () => {
  const result = buildLabelJobSnapshot({ order, sparePerSku: 2 });
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].barcodeValue, "15100");
  assert.equal(result.rows[0].barcodeFormat, "Code 128");
  assert.equal(result.rows[0].labelsPerUnit, 2);
  assert.equal(result.rows[0].labelsRequired, 22);
  assert.equal(result.totals.labelsRequired, 66);
});

test("requires colour and then size where a buying code is shared", () => {
  const noColour = buildLabelJobSnapshot({ order: { lines: [{ sku: "1", buyingCode: "A", quantity: 1 }, { sku: "2", buyingCode: "A", quantity: 1 }] } });
  assert.equal(noColour.valid, false);
  assert.ok(noColour.errors.some(message => message.includes("needs a colour")));
  const noSize = buildLabelJobSnapshot({ order: { lines: [{ sku: "1", buyingCode: "A", colour: "Blue", quantity: 1 }, { sku: "2", buyingCode: "A", colour: "Blue", quantity: 1 }] } });
  assert.equal(noSize.valid, false);
  assert.ok(noSize.errors.some(message => message.includes("needs a size")));
});

test("supplier guide grouping ignores buying-code and style capitalization", () => {
  const result = buildLabelJobSnapshot({
    order: {
      lines: [
        { sku: "1", buyingCode: "MIA24", style: "Mia dress", colour: "Navy", size: "S", quantity: 1 },
        { sku: "2", buyingCode: "mia24", style: "MIA DRESS", colour: "Red", size: "M", quantity: 1 }
      ]
    }
  });
  assert.equal(result.valid, true);
  assert.equal(new Set(result.rows.map(row => row.supplierGuideGroupKey)).size, 1);
});

test("uses batch allocations and rejects empty scopes", () => {
  const batchLines = [{ batchId: "b1", lineIndex: 1, quantity: 5 }];
  const result = buildLabelJobSnapshot({ order, batchLines, scopeType: "batch", batchId: "b1" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sku, "15101");
  assert.equal(result.rows[0].orderedQuantity, 5);
  assert.equal(buildLabelJobSnapshot({ order, batchLines, scopeType: "batch", batchId: "missing" }).valid, false);
});

test("can generate only selected extra order lines", () => {
  const result = buildLabelJobSnapshot({
    order,
    selectedLineIndexes: [2],
    selectionRequired: true,
    sparePerSku: 1
  });
  assert.equal(result.valid, true);
  assert.equal(result.selectionMode, "selected");
  assert.deepEqual(result.selectedLineIndexes, [2]);
  assert.equal(result.scopeLabel, "Selected lines (1) from Full order");
  assert.deepEqual(result.rows.map(row => row.sku), ["15102"]);
  assert.equal(result.totals.labelsRequired, 17);
});

test("selected-line mode requires a selection", () => {
  const result = buildLabelJobSnapshot({ order, selectionRequired: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(message => message.includes("Select at least one extra order line")));
});

test("corrects legacy label snapshots that only counted one label per unit", () => {
  const corrected = normalizeDoubleBarcodeSnapshot({
    rows: [{ sku: "15110", orderedQuantity: 5, spareQuantity: 2, labelsRequired: 7 }],
    totals: { orderedUnits: 5, spareLabels: 2, labelsRequired: 7 }
  });
  assert.equal(corrected.rows[0].labelsPerUnit, 2);
  assert.equal(corrected.rows[0].labelsRequired, 12);
  assert.equal(corrected.totals.applicationLabels, 10);
  assert.equal(corrected.totals.labelsRequired, 12);
});
