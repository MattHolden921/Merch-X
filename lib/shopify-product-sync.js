function cleanText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizedValue(value) {
  return cleanText(value).toLowerCase();
}

function normalizedSku(value) {
  return cleanText(value).toUpperCase();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function productGroupId(product = {}) {
  return cleanText(product.shopifyVariantGroupId);
}

function productSize(product = {}) {
  return cleanText(product.size || product.optionValue);
}

function productLead(products = []) {
  return products.find(product => product.shopifyVariantGroupPrimary) || products[0] || null;
}

function orderedGroupProducts(products = []) {
  const lead = productLead(products);
  return [...products].sort((left, right) => {
    if (left === lead) return -1;
    if (right === lead) return 1;
    return productSize(left).localeCompare(productSize(right), "en-GB", { numeric: true, sensitivity: "base" });
  });
}

function sizeVariantGroupValidation(products = []) {
  const members = orderedGroupProducts(products);
  const lead = productLead(members);
  const blocking = [];
  const warnings = [];
  if (members.length < 2) blocking.push("A size-variant group needs at least two products");

  const requiredSharedFields = [
    ["title/style", product => product.title || product.style],
    ["supplier", product => product.supplierName],
    ["buying code", product => product.buyingCode || product.supplierSku],
    ["colour", product => product.colour || product.color],
    ["product type", product => product.productType || product.category]
  ];
  const matchingSharedFields = [
    ...requiredSharedFields,
    ["season", product => product.season]
  ];

  for (const [label, valueFor] of requiredSharedFields) {
    if (members.some(product => !cleanText(valueFor(product)))) blocking.push(`Missing ${label} on one or more group members`);
  }
  for (const [label, valueFor] of matchingSharedFields) {
    const values = new Set(members.map(product => normalizedValue(valueFor(product))));
    if (values.size > 1) blocking.push(`Group members must have the same ${label}`);
  }

  const skus = members.map(product => normalizedSku(product.sku));
  if (skus.some(sku => !sku)) blocking.push("Every group member needs a SKU");
  if (new Set(skus.filter(Boolean)).size !== skus.filter(Boolean).length) blocking.push("Group member SKUs must be unique");

  const sizes = members.map(productSize);
  if (sizes.some(size => !size)) blocking.push("Every group member needs an explicit size");
  const normalizedSizes = sizes.map(normalizedValue).filter(Boolean);
  if (new Set(normalizedSizes).size !== normalizedSizes.length) blocking.push("Group member sizes must be unique");

  if (members.some(product => product.shopifyProductGid || product.shopifyVariantGid || ["Shopify draft", "Live"].includes(product.status) || product.syncStatus === "Synced draft")) {
    blocking.push("Group members must not already be linked to Shopify");
  }

  const leadFields = [
    ["image", product => product.imageUrl],
    ["description", product => product.description],
    ["details and fit", product => product.detailsAndFit],
    ["fabric care", product => product.fabricCare],
    ["department", product => product.department || product.category],
    ["tags", product => Array.isArray(product.tags) ? product.tags.join("|") : product.tags],
    ["collections", product => Array.isArray(product.collections) ? product.collections.join("|") : product.collections]
  ];
  for (const [label, valueFor] of leadFields) {
    const values = new Set(members.map(product => normalizedValue(valueFor(product))));
    if (values.size > 1) warnings.push(`${label} differs; lead SKU ${lead?.sku || ""} will supply the product-level value`);
  }

  return {
    ready: blocking.length === 0,
    blocking: [...new Set(blocking)],
    warnings: [...new Set(warnings)],
    lead,
    members
  };
}

function selectedProductSyncUnits(allProducts = [], selectedIds = []) {
  const byId = new Map();
  const bySku = new Map();
  const groups = new Map();
  for (const product of allProducts) {
    byId.set(String(product.id), product);
    bySku.set(normalizedSku(product.sku), product);
    const groupId = productGroupId(product);
    if (!groupId) continue;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(product);
  }

  const units = [];
  const seen = new Set();
  for (const identifier of selectedIds) {
    const product = byId.get(String(identifier)) || bySku.get(normalizedSku(identifier));
    if (!product) continue;
    const groupId = productGroupId(product);
    const key = groupId ? `group:${groupId}` : `product:${product.id || normalizedSku(product.sku)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const products = groupId ? orderedGroupProducts(groups.get(groupId) || [product]) : [product];
    units.push({
      key,
      mode: groupId ? "size_variants" : "single",
      groupId,
      primary: productLead(products),
      products
    });
  }
  return units;
}

function sizeVariantInputs(products = [], sizeOptionName = "Size") {
  const members = orderedGroupProducts(products);
  const optionValues = [...new Set(members.map(product => productSize(product) || "One Size Fits UK 8 to 18"))];
  const variants = members.map(product => {
    const colour = cleanText(product.colour || product.color);
    const variant = {
      optionValues: [{ optionName: sizeOptionName, name: productSize(product) || "One Size Fits UK 8 to 18" }],
      ...(colour ? {
        metafields: [{ namespace: "custom", key: "colour", type: "single_line_text_field", value: colour }]
      } : {}),
      price: numberOrZero(product.rrp).toFixed(2),
      sku: product.sku,
      inventoryItem: {
        sku: product.sku,
        tracked: true,
        cost: numberOrZero(product.unitCostGbp).toFixed(2)
      }
    };
    if (numberOrZero(product.compareAtPrice)) variant.compareAtPrice = numberOrZero(product.compareAtPrice).toFixed(2);
    if (product.barcode) variant.barcode = product.barcode;
    return variant;
  });
  return {
    productOptions: [{ name: sizeOptionName, position: 1, values: optionValues.map(name => ({ name })) }],
    variants
  };
}

module.exports = {
  cleanText,
  orderedGroupProducts,
  productGroupId,
  productLead,
  productSize,
  selectedProductSyncUnits,
  sizeVariantInputs,
  sizeVariantGroupValidation
};
