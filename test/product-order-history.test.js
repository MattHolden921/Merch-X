"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { latestOrderBySku, orderByNumber } = require("../lib/product-order-history");

test("returns the most recent dated order for each SKU", () => {
  const result = latestOrderBySku([
    { id: "new", orderNumber: "PO-102", orderDate: "2026-08-02", savedAt: "2026-08-02T10:00:00Z", lines: [{ sku: " abc-1 " }] },
    { id: "old", orderNumber: "PO-101", orderDate: "2026-07-20", savedAt: "2026-08-05T10:00:00Z", lines: [{ sku: "ABC-1" }] }
  ]);

  assert.deepEqual(result.get("ABC-1"), {
    id: "new",
    orderNumber: "PO-102",
    orderDate: "2026-08-02",
    savedAt: "2026-08-02T10:00:00Z"
  });
});

test("uses saved time when an order date is unavailable", () => {
  const result = latestOrderBySku([
    { id: "1", orderNumber: "PO-1", savedAt: "2026-08-01T10:00:00Z", lines: [{ sku: "ABC-2" }] },
    { id: "2", orderNumber: "PO-2", savedAt: "2026-08-03T10:00:00Z", lines: [{ sku: "abc-2" }] }
  ]);

  assert.equal(result.get("ABC-2").id, "2");
});

test("indexes order numbers for legacy product-history links", () => {
  const result = orderByNumber([
    { id: "legacy", orderNumber: "PO-99", orderDate: "2026-06-01" }
  ]);

  assert.equal(result.get("PO-99").id, "legacy");
});
