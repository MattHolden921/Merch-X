const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("../lib/shopify-product-sync");

function product(overrides = {}) {
  return {
    id: overrides.id || 1,
    sku: overrides.sku || "15100",
    title: "Tessa Dress Navy",
    supplierName: "Supplier",
    buyingCode: "TESSA",
    colour: "Navy",
    productType: "Dresses",
    season: "AW26",
    size: overrides.size || "S/M",
    imageUrl: "/uploads/product.jpg",
    status: "Ready for Shopify",
    syncStatus: "Ready",
    ...overrides
  };
}

test("a valid size group keeps distinct SKUs and size values", () => {
  const result = sync.sizeVariantGroupValidation([
    product({ id: 1, sku: "15100", size: "S/M", shopifyVariantGroupPrimary: true }),
    product({ id: 2, sku: "15101", size: "M/L", title: "tessa dress navy", supplierName: "SUPPLIER", buyingCode: "tessa", colour: "NAVY", productType: "DRESSES", season: "aw26" })
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.lead.sku, "15100");
  assert.deepEqual(result.members.map(item => item.sku), ["15100", "15101"]);
});

test("size groups reject ambiguous product identity and duplicate sizes", () => {
  const result = sync.sizeVariantGroupValidation([
    product({ id: 1, sku: "15100", size: "S/M" }),
    product({ id: 2, sku: "15101", size: "s/m", colour: "Black" })
  ]);
  assert.equal(result.ready, false);
  assert.match(result.blocking.join("; "), /same colour/);
  assert.match(result.blocking.join("; "), /sizes must be unique/);
});

test("selecting one member expands to the complete persistent group", () => {
  const products = [
    product({ id: 1, sku: "15100", size: "S/M", shopifyVariantGroupId: "group-1", shopifyVariantGroupPrimary: true }),
    product({ id: 2, sku: "15101", size: "M/L", shopifyVariantGroupId: "group-1" }),
    product({ id: 3, sku: "15102", size: "One Size" })
  ];
  const units = sync.selectedProductSyncUnits(products, ["2", "3"]);
  assert.equal(units.length, 2);
  assert.equal(units[0].mode, "size_variants");
  assert.deepEqual(units[0].products.map(item => item.sku), ["15100", "15101"]);
  assert.equal(units[1].mode, "single");
});

test("builds one Size option with a complete Shopify variant per local SKU", () => {
  const input = sync.sizeVariantInputs([
    product({ id: 1, sku: "15100", size: "S/M", rrp: 39, unitCostGbp: 8.5, barcode: "15100", shopifyVariantGroupPrimary: true }),
    product({ id: 2, sku: "15101", size: "M/L", rrp: 42, unitCostGbp: 9, barcode: "15101" })
  ]);
  assert.deepEqual(input.productOptions[0].values, [{ name: "S/M" }, { name: "M/L" }]);
  assert.deepEqual(input.variants.map(variant => ({
    sku: variant.sku,
    size: variant.optionValues[0].name,
    price: variant.price,
    cost: variant.inventoryItem.cost,
    barcode: variant.barcode
  })), [
    { sku: "15100", size: "S/M", price: "39.00", cost: "8.50", barcode: "15100" },
    { sku: "15101", size: "M/L", price: "42.00", cost: "9.00", barcode: "15101" }
  ]);
});

test("linked products cannot be newly grouped", () => {
  const result = sync.sizeVariantGroupValidation([
    product({ id: 1, sku: "15100", size: "S/M", shopifyProductGid: "gid://shopify/Product/1" }),
    product({ id: 2, sku: "15101", size: "M/L" })
  ]);
  assert.equal(result.ready, false);
  assert.match(result.blocking.join("; "), /must not already be linked/);
});
