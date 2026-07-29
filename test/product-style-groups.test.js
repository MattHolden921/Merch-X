const test = require("node:test");
const assert = require("node:assert/strict");
const styleGroups = require("../lib/product-style-groups");

test("Style Group names resolve to stable Shopify handles", () => {
  assert.equal(styleGroups.handleForName("  Whitstable V Neck Floral  "), "whitstable-v-neck-floral");
  assert.equal(styleGroups.handleForName("Abigail & Co. Scarf"), "abigail-co-scarf");
});

test("Style Group name matching ignores capitalization and punctuation", () => {
  assert.equal(styleGroups.normalizedKey("Abigail-Scarf"), styleGroups.normalizedKey("abigail scarf"));
});
