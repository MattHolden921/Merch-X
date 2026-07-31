"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { acknowledgedRemovalsCover, removedOrderSkus } = require("../lib/order-line-integrity");

test("detects SKUs removed from an existing order without treating reordering as removal", () => {
  const previous = { lines: [{ sku: "15446" }, { sku: "15447" }, { sku: "15448" }] };
  const next = { lines: [{ sku: "15448" }, { sku: "15446" }] };
  assert.deepEqual(removedOrderSkus(previous, next), ["15447"]);
});

test("requires explicit acknowledgement for every removed SKU", () => {
  assert.equal(acknowledgedRemovalsCover(["15447", "15448"], ["15447"]), false);
  assert.equal(acknowledgedRemovalsCover(["15447", "15448"], ["15448", "15447"]), true);
  assert.equal(acknowledgedRemovalsCover(["ab-1"], [" AB-1 "]), true);
});
