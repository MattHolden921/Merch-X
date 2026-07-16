"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const actuals = require("../lib/order-actuals");

test("calculates receipt variances from expected, received, damaged, and accepted quantities", () => {
  const line = actuals.calculateReceiptLine({
    expectedQuantity: 10,
    receivedQuantity: 9,
    damagedQuantity: 2
  });
  assert.deepEqual(line, {
    expectedQuantity: 10,
    receivedQuantity: 9,
    damagedQuantity: 2,
    acceptedQuantity: 7,
    shortQuantity: 1,
    overQuantity: 0
  });
});

test("creates discrepancy drafts for shortage, damage, and overage", () => {
  const order = {
    id: "o1",
    lines: [{ sku: "15100", buyingCode: "ART1", style: "Dress", quantity: 10, lineCost: 50 }]
  };
  const receiptLines = [{
    id: "r1",
    lineIndex: 0,
    sku: "15100",
    expectedQuantity: 10,
    receivedQuantity: 12,
    damagedQuantity: 1,
    acceptedQuantity: 11,
    shortQuantity: 0,
    overQuantity: 2,
    notes: "Supplier packed two extra; one damaged"
  }];
  const drafts = actuals.discrepancyDraftsForReceipt({ order, batch: { id: "b1", currency: "EUR" }, receiptLines });
  assert.equal(drafts.length, 2);
  assert.equal(drafts.find(item => item.discrepancyType === "damage").valueGbp, 5);
  assert.equal(drafts.find(item => item.discrepancyType === "overage").quantity, 2);
  assert.equal(drafts.find(item => item.discrepancyType === "damage").notes, "Supplier packed two extra; one damaged");
});

test("treats credit notes as signed finance documents", () => {
  assert.equal(actuals.normalizeDocumentKind({ invoiceType: "Credit note" }), "credit_note");
  assert.equal(actuals.signedInvoiceAmount({ invoiceType: "Credit note", amount: 25 }), -25);
  assert.equal(actuals.signedInvoiceAmount({ documentKind: "invoice", amount: 40 }), 40);
});

test("summarizes supplier performance across operational and finance rows", () => {
  const rows = [
    {
      supplierName: "Alpha",
      units: 10,
      totalGbp: 100,
      invoices: { outstanding: 20 },
      actuals: { expectedQuantity: 10, receivedQuantity: 9, acceptedQuantity: 8, damagedQuantity: 1, shortQuantity: 1, overQuantity: 0 },
      discrepancies: { openCount: 1, openValueGbp: 15, creditDueGbp: 10, creditReceivedGbp: 5 },
      batches: { received: 1, onTime: 1, late: 0, openBatches: 0 }
    },
    {
      supplierName: "ALPHA",
      units: 5,
      totalGbp: 50,
      invoices: { outstanding: 0 },
      actuals: { expectedQuantity: 5, receivedQuantity: 5, acceptedQuantity: 5 },
      discrepancies: {},
      batches: { received: 1, onTime: 0, late: 1, openBatches: 1 }
    }
  ];
  const [supplier] = actuals.summarizeSupplierPerformance(rows);
  assert.equal(supplier.supplierName, "Alpha");
  assert.equal(supplier.orders, 2);
  assert.equal(supplier.orderedUnits, 15);
  assert.equal(supplier.acceptedUnits, 13);
  assert.equal(Math.round(supplier.fillRate * 100), 87);
  assert.equal(supplier.openCreditValueGbp, 10);
  assert.equal(supplier.onTimeRate, 0.5);
});

test("summarizes supplier credit balances from credit-note discrepancies", () => {
  const credits = actuals.summarizeSupplierCredits([
    { supplierName: "Alpha", orderId: "o1", orderNumber: "PO-1", status: "Credit requested", valueGbp: 25, sku: "15100" },
    { supplierName: "ALPHA", orderId: "o2", orderNumber: "PO-2", status: "Open", resolutionType: "credit_note", valueGbp: 35, sku: "15101" },
    { supplierName: "alpha", orderId: "o3", orderNumber: "PO-3", status: "Credit received", valueGbp: 12 },
    { supplierName: "Alpha", orderId: "o4", orderNumber: "PO-4", status: "Written off", resolutionType: "credit_note", valueGbp: 9 },
    { supplierName: "Beta", orderId: "o5", orderNumber: "PO-5", status: "Replacement expected", resolutionType: "replacement", valueGbp: 18 }
  ]);
  const alpha = credits.find(row => row.supplierName === "Alpha");
  assert.equal(credits.length, 1);
  assert.equal(alpha.creditDueGbp, 60);
  assert.equal(alpha.openCreditCount, 2);
  assert.equal(alpha.creditReceivedGbp, 12);
  assert.equal(alpha.receivedCreditCount, 1);
  assert.deepEqual(alpha.items.map(item => item.orderNumber).sort(), ["PO-1", "PO-2"]);
});
