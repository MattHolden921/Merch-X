const test = require("node:test");
const assert = require("node:assert/strict");
const cleanup = require("../lib/new-arrivals-cleanup");

test("uses published date and excludes products exactly on the cutoff", () => {
  const products = [
    { id: "old", title: "Old", status: "ACTIVE", createdAt: "2025-01-01", publishedAt: "2026-04-30" },
    { id: "boundary", title: "Boundary", status: "ACTIVE", createdAt: "2025-01-01", publishedAt: "2026-05-01" },
    { id: "new", title: "New", status: "ACTIVE", publishedAt: "2026-05-02" }
  ];
  assert.deepEqual(cleanup.cleanupCandidates(products, "2026-05-01").map(product => product.id), ["old"]);
});

test("falls back to created date only for active products", () => {
  const products = [
    { id: "active", status: "ACTIVE", createdAt: "2026-01-01" },
    { id: "draft", status: "DRAFT", createdAt: "2026-01-01" }
  ];
  assert.deepEqual(cleanup.cleanupCandidates(products, "2026-05-01").map(product => product.id), ["active"]);
});

test("requires the exact New Arrivals tag without changing other tags", () => {
  const products = [
    { id: "exact", status: "ACTIVE", createdAt: "2026-01-01", tags: ["Linen", "Collection: New Arrivals"] },
    { id: "case", status: "ACTIVE", createdAt: "2026-01-01", tags: ["collection: new arrivals", "Blue"] },
    { id: "near", status: "ACTIVE", createdAt: "2026-01-01", tags: ["New Arrivals"] },
    { id: "none", status: "ACTIVE", createdAt: "2026-01-01", tags: ["Linen"] }
  ];
  assert.deepEqual(cleanup.cleanupCandidates(products, "2026-05-01", "Collection: New Arrivals").map(product => product.id), ["exact"]);
  assert.deepEqual(products[0].tags, ["Linen", "Collection: New Arrivals"]);
});

test("cutoff dates and preview hashes are stable", () => {
  assert.equal(cleanup.cutoffDate(60, new Date("2026-07-20T15:00:00Z")), "2026-05-21");
  assert.equal(cleanup.previewHash("collection", "2026-05-21", ["b", "a"]), cleanup.previewHash("collection", "2026-05-21", ["a", "b"]));
  assert.notEqual(cleanup.previewHash("collection", "2026-05-21", ["a"]), cleanup.previewHash("collection", "2026-05-21", ["a", "b"]));
});
