const test = require("node:test");
const assert = require("node:assert/strict");
const ranking = require("../public/collection-ranking");

function product(overrides = {}) {
  return {
    id: overrides.id || Math.random().toString(36),
    currentPosition: 1,
    title: "Harper Linen Dress Navy",
    buyingCode: "",
    color: "Navy",
    productType: "Dress",
    status: "ACTIVE",
    publishedAt: "2026-07-01T00:00:00Z",
    revenue: 100,
    units: 3,
    stock: 10,
    margin: 70,
    gaViews: 100,
    gaPurchases: 5,
    tags: [],
    ...overrides
  };
}

test("uses GA purchases rather than Shopify units for CVR", () => {
  assert.equal(ranking.productCvr(product({ units: 20, gaViews: 100, gaPurchases: 4 })), 0.04);
});

test("buying code groups colourways and title fallback covers legacy products", () => {
  const codedBlue = ranking.styleParts(product({ title: "Harper Dress Navy", buyingCode: "ART-55", color: "Navy" }));
  const codedPink = ranking.styleParts(product({ title: "Completely Different Pink", buyingCode: "ART-55", color: "Pink" }));
  assert.equal(codedBlue.styleKey, codedPink.styleKey);
  assert.equal(codedBlue.styleSource, "buying code");

  const legacyBlue = ranking.styleParts(product({ title: "Harper Dress Royal Blue", buyingCode: "", color: "Blue" }));
  const legacyPink = ranking.styleParts(product({ title: "Harper Dress Light Pink", buyingCode: "", color: "Pink" }));
  assert.equal(legacyBlue.styleKey, legacyPink.styleKey);
  assert.equal(legacyBlue.styleSource, "title fallback");
});

test("does not force unrelated single styles into pairs", () => {
  const rows = ranking.rankProducts([
    product({ id: "a", title: "Alpha Dress Navy", currentPosition: 1, revenue: 500 }),
    product({ id: "b", title: "Beta Dress Pink", currentPosition: 2, revenue: 10 })
  ], { strategy: "bestSellers", now: Date.parse("2026-07-13T00:00:00Z") }).rows;
  assert.ok(rows.every(row => !row.reason.includes("paired")));
});

test("GA strategies are unavailable without GA data", () => {
  const result = ranking.rankProducts([product()], { strategy: "conversionLift", gaAvailable: false });
  assert.equal(result.rows.length, 0);
  assert.match(result.unavailableReason, /GA4/);
});

test("inactive, unpublished, and out-of-stock products stay below eligible products", () => {
  const rows = ranking.rankProducts([
    product({ id: "draft", status: "DRAFT", revenue: 1000 }),
    product({ id: "unpublished", status: "ACTIVE", publishedAt: "", revenue: 900 }),
    product({ id: "oos", stock: 0, revenue: 800 }),
    product({ id: "live", revenue: 1 })
  ], { strategy: "bestSellers", now: Date.parse("2026-07-13T00:00:00Z") }).rows;
  assert.equal(rows[0].id, "live");
  assert.deepEqual(rows.slice(1).map(row => row.id), ["draft", "unpublished", "oos"]);
});

test("robust caps keep a revenue outlier from flattening every other score", () => {
  const rows = ranking.rankProducts([
    product({ id: "outlier", currentPosition: 3, revenue: 1_000_000, units: 1000 }),
    product({ id: "strong", currentPosition: 2, revenue: 500, units: 10 }),
    product({ id: "steady", currentPosition: 1, revenue: 300, units: 8 })
  ], { strategy: "bestSellers", now: Date.parse("2026-07-13T00:00:00Z") }).rows;
  const steady = rows.find(row => row.id === "steady");
  assert.ok(steady.score > 35);
});

test("missing margin is visible and receives no margin score credit", () => {
  const missing = product({ id: "missing", margin: null });
  const known = product({ id: "known", margin: 80 });
  const context = ranking.createContext([missing, known], { days: 30, now: Date.parse("2026-07-13T00:00:00Z") });
  assert.equal(ranking.signals(missing, context).margin, 0);
  assert.equal(ranking.signals(missing, context).marginAvailable, false);
  assert.equal(ranking.signals(known, context).margin, 0.8);
});
