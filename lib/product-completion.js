"use strict";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function productIsShopifyComplete(product = {}) {
  const status = text(product.status || product.productStatus).toLowerCase();
  const syncStatus = text(product.syncStatus).toLowerCase();
  const shopifyStatus = text(product.shopifyStatus).toUpperCase();
  const productGid = text(product.shopifyProductGid);
  const variantGid = text(product.shopifyVariantGid);
  const isSizeGroup = Boolean(text(product.shopifyVariantGroupId));

  if (["conflict", "error"].includes(syncStatus)) return false;
  if (isSizeGroup) return Boolean(productGid && variantGid);

  return Boolean(
    productGid
    || variantGid
    || ["synced", "synced draft"].includes(syncStatus)
    || status === "shopify draft"
    || status === "live"
    || shopifyStatus === "DRAFT"
    || shopifyStatus === "ACTIVE"
  );
}

function productCompletionSource(product = {}) {
  const isSizeGroup = Boolean(text(product.shopifyVariantGroupId));
  const productGid = text(product.shopifyProductGid);
  const variantGid = text(product.shopifyVariantGid);
  if (isSizeGroup && productGid && variantGid) return "Shopify variant linked";
  if (isSizeGroup && productGid) return "Variant link missing";
  if (productGid || variantGid) return "Shopify linked";
  if (product.syncStatus === "Synced draft") return "Synced draft";
  if (product.status === "Live") return "Live";
  if (product.status === "Shopify draft") return "Shopify draft";
  if (product.shopifyStatus) return product.shopifyStatus;
  if (product.syncStatus) return product.syncStatus;
  return product.status || "Not synced";
}

module.exports = { productCompletionSource, productIsShopifyComplete };
