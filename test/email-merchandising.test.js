"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { eligibility, recommendProducts, repeatState, trackedProductUrl } = require("../lib/email-merchandising");

const now = "2026-06-21T12:00:00.000Z";
function product(id, patch = {}) {
  return { id, status: "ACTIVE", publishedAt: "2026-05-01", createdAt: "2026-05-01", stock: 20, imageUrl: `https://img/${id}.jpg`, price: 49, handle: id, title: `Product ${id}`, productType: `Type ${Number(id.replace(/\D/g, "")) % 3}`, color: ["Navy", "Cream", "Red"][Number(id.replace(/\D/g, "")) % 3], season: "SS26", revenue: 100, gaViews: 20, gaPurchases: 2, margin: 70, ...patch };
}

test("eligibility rejects incomplete and unavailable products", () => {
  assert.equal(eligibility(product("a")).eligible, true);
  const result = eligibility(product("b", { status: "DRAFT", stock: 0, imageUrl: "" }));
  assert.equal(result.eligible, false);
  assert.equal(result.reasons.length, 3);
});

test("repeat policy locks four weeks and fades through week eight", () => {
  assert.equal(repeatState("2026-06-01", new Date(now)).locked, true);
  const soft = repeatState("2026-05-01", new Date(now));
  assert.equal(soft.locked, false);
  assert.ok(soft.multiplier > 0.35 && soft.multiplier < 1);
  assert.equal(repeatState("2026-01-01", new Date(now)).multiplier, 1);
});

test("recommendations are deterministic, preserve pins, and enforce diversity", () => {
  const source = Array.from({ length: 12 }, (_, index) => product(`p${index + 1}`, { revenue: 12 - index, gaViews: index + 1 }));
  const first = recommendProducts(source, {}, { objective: "balanced", now, pinnedProductIds: ["p9"] });
  const second = recommendProducts(source, {}, { objective: "balanced", now, pinnedProductIds: ["p9"] });
  assert.deepEqual(first.products.map(item => item.id), second.products.map(item => item.id));
  assert.equal(first.products.length, 6);
  assert.ok(first.products.some(item => item.id === "p9"));
  const typeCounts = Object.values(first.products.reduce((counts, item) => ({ ...counts, [item.productType]: (counts[item.productType] || 0) + 1 }), {}));
  assert.ok(typeCounts.every(count => count <= 2));
});

test("sent products are excluded while unsent products do not affect history", () => {
  const source = Array.from({ length: 8 }, (_, index) => product(`p${index + 1}`));
  const result = recommendProducts(source, { p1: "2026-06-10" }, { objective: "proven", now });
  assert.equal(result.products.some(item => item.id === "p1"), false);
  assert.equal(result.ineligible.some(item => item.id === "p1" && item.repeat.locked), true);
});

test("objectives work without GA4 or margin values", () => {
  const source = Array.from({ length: 7 }, (_, index) => product(`p${index + 1}`, { gaViews: 0, gaPurchases: 0, margin: null }));
  for (const objective of ["balanced", "new_in", "underexposed", "never_featured", "proven"]) {
    assert.equal(recommendProducts(source, {}, { objective, now }).products.length, 6);
  }
});

test("theme and shared style terms keep the sixth product coherent", () => {
  const linen = Array.from({ length: 7 }, (_, index) => product(`linen${index + 1}`, { title: `Washed Linen Dress ${index + 1}`, tags: ["linen", "summer"], productType: index % 2 ? "Dresses" : "Tops", color: index % 2 ? "Navy" : "Cream", revenue: 50 + index }));
  const unrelated = [product("boot1", { title: "Leather Winter Boot", tags: ["leather", "winter"], productType: "Footwear", color: "Black", revenue: 500 }), product("coat1", { title: "Wool Winter Coat", tags: ["wool", "winter"], productType: "Coats", color: "Black", revenue: 450 })];
  const result = recommendProducts([...linen, ...unrelated], {}, { objective: "balanced", theme: "linen summer", now });
  assert.equal(result.products.length, 6);
  assert.ok(result.products.every(item => item.tags.includes("linen")));
});

test("tracked links carry stable campaign and slot attribution", () => {
  const url = new URL(trackedProductUrl(product("p1"), "mx-20260621-summer", 2, "https://shop.example"));
  assert.equal(url.searchParams.get("utm_source"), "klaviyo");
  assert.equal(url.searchParams.get("utm_campaign"), "mx-20260621-summer");
  assert.match(url.searchParams.get("utm_content"), /^slot-2-/);
});
