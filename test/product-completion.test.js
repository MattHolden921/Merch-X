"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { productCompletionSource, productIsShopifyComplete } = require("../lib/product-completion");

test("requires the exact Shopify variant link for a saved size group", () => {
  const grouped = {
    shopifyVariantGroupId: "group-1",
    shopifyProductGid: "gid://shopify/Product/1",
    syncStatus: "Synced draft",
    status: "Shopify draft"
  };

  assert.equal(productIsShopifyComplete(grouped), false);
  assert.equal(productCompletionSource(grouped), "Variant link missing");
  assert.equal(productIsShopifyComplete({
    ...grouped,
    shopifyVariantGid: "gid://shopify/ProductVariant/11"
  }), true);
});

test("does not treat conflict or error states as complete", () => {
  assert.equal(productIsShopifyComplete({
    shopifyProductGid: "gid://shopify/Product/1",
    syncStatus: "Conflict"
  }), false);
  assert.equal(productIsShopifyComplete({
    shopifyVariantGid: "gid://shopify/ProductVariant/11",
    syncStatus: "Error"
  }), false);
});

test("preserves the established completion signals for standalone products", () => {
  assert.equal(productIsShopifyComplete({ shopifyProductGid: "gid://shopify/Product/1" }), true);
  assert.equal(productIsShopifyComplete({ syncStatus: "Synced draft" }), true);
  assert.equal(productIsShopifyComplete({ status: "Live" }), true);
});
