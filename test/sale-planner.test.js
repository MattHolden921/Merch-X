"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectionMembershipForProduct,
  gpPercentFromRetail,
  matchSaleChildCollection,
  recommendMarkdown,
  removeSaleTargets,
  roundSalePrice,
  targetPriceForDiscount,
  variantSaleTargets
} = require("../lib/sale-planner");

test("rounds sale prices to the nearest pound by default", () => {
  assert.equal(targetPriceForDiscount(49, 20), 39);
  assert.equal(roundSalePrice(31.55), 32);
  assert.equal(roundSalePrice(31.55, "end-99"), 31.99);
  assert.equal(roundSalePrice(31.555, "preserve-pennies"), 31.56);
  assert.equal(gpPercentFromRetail(60, 25), 50);
});

test("recommends risk ladder steps from stock, cover, age, and sales", () => {
  const mild = recommendMarkdown({ title: "Mild", price: 40, stock: 4, units: 2, coverWks: 5 }, { now: "2026-06-23" });
  assert.equal(mild.discountPercent, 10);

  const medium = recommendMarkdown({ title: "Medium", price: 50, stock: 12, units: 1, coverWks: 9 }, { now: "2026-06-23" });
  assert.equal(medium.discountPercent, 20);

  const high = recommendMarkdown({ title: "High", price: 50, stock: 24, units: 1, coverWks: 14 }, { now: "2026-06-23" });
  assert.equal(high.discountPercent, 30);

  const deeper = recommendMarkdown({ title: "Deep", price: 50, stock: 35, units: 0, coverWks: 26, publishedAt: "2025-11-01" }, { now: "2026-06-23" });
  assert.equal(deeper.discountPercent, 40);

  const final = recommendMarkdown({ title: "Final", price: 50, stock: 55, units: 0, coverWks: 60, publishedAt: "2025-01-01" }, { now: "2026-06-23" });
  assert.equal(final.discountPercent, 50);
  assert.ok(final.warnings.some(message => message.includes("Final-clearance")));
});

test("deepens existing markdowns and uses compare-at as original price", () => {
  const suggestion = recommendMarkdown({ title: "Marked", price: 40, compareAtPrice: 50, stock: 15, units: 1, coverWks: 8 }, { now: "2026-06-23" });
  assert.equal(suggestion.originalPrice, 50);
  assert.equal(suggestion.existingMarkdownPercent, 20);
  assert.equal(suggestion.discountPercent, 30);
  assert.equal(suggestion.targetPrice, 35);
});

test("builds variant sale targets and warns below cost", () => {
  const targets = variantSaleTargets({
    variants: [
      { id: "v1", sku: "A", price: 50, cost: 20 },
      { id: "v2", sku: "B", price: 40, compareAtPrice: 60, cost: 45 }
    ]
  }, 30);
  assert.deepEqual(targets.map(item => item.targetPrice), [35, 42]);
  assert.deepEqual(targets.map(item => item.targetGpPct), [31.4, -28.6]);
  assert.equal(targets[1].compareAtPrice, 60);
  assert.ok(targets[1].warnings.some(message => message.includes("below variant cost")));
});

test("matches sale root and child collections by title or handle with overrides", () => {
  const collections = [
    { id: "c1", title: "Sale", handle: "sale" },
    { id: "c2", title: "Sale Tops", handle: "sale-tops" },
    { id: "c3", title: "Sale Dresses", handle: "sale-dresses" }
  ];
  const auto = matchSaleChildCollection("Tops", collections);
  assert.equal(auto.collection.id, "c2");
  assert.equal(auto.source, "auto");

  const override = matchSaleChildCollection("Tops", collections, { Tops: "c3" });
  assert.equal(override.collection.id, "c3");
  assert.equal(override.source, "override");

  const membership = collectionMembershipForProduct({ productType: "Tops" }, collections);
  assert.equal(membership.rootSale.id, "c1");
  assert.equal(membership.childSale.id, "c2");
  assert.deepEqual(membership.missing, []);
});

test("remove sale restores compare-at price or warns when none exists", () => {
  const targets = removeSaleTargets({
    variants: [
      { id: "v1", sku: "A", price: 35, compareAtPrice: 50 },
      { id: "v2", sku: "B", price: 29, compareAtPrice: null }
    ]
  });
  assert.equal(targets[0].restoredPrice, 50);
  assert.equal(targets[0].compareAtPrice, 50);
  assert.equal(targets[1].restoredPrice, 29);
  assert.ok(targets[1].warnings.some(message => message.includes("No compare-at")));
});
