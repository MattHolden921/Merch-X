"use strict";

const DEFAULT_MARKDOWN_STEPS = [10, 20, 30, 40, 50];

function text(value) {
  return String(value == null ? "" : value).trim();
}

function number(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, number(value)));
}

function money(value) {
  const numeric = number(value);
  return Math.round(numeric * 100) / 100;
}

function daysBetween(from, to = new Date()) {
  const value = new Date(from);
  if (!Number.isFinite(value.getTime())) return null;
  return Math.max(0, Math.floor((to.getTime() - value.getTime()) / 864e5));
}

function normalizeKey(value) {
  return text(value).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function pluralStem(value) {
  const normalized = normalizeKey(value);
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  if (normalized.endsWith("s")) return normalized.slice(0, -1);
  return normalized;
}

function productKey(product = {}) {
  return text(product.id || product.productKey || product.legacyResourceId || product.handle || product.sku || product.title);
}

function originalPrice(product = {}) {
  const price = number(product.price ?? product.rrp);
  const compareAt = number(product.compareAtPrice);
  return compareAt > price && price > 0 ? compareAt : price;
}

function currentPrice(product = {}) {
  return number(product.price ?? product.rrp);
}

function currentMarkdownPercent(product = {}) {
  const original = originalPrice(product);
  const current = currentPrice(product);
  if (!(original > current && current > 0)) return 0;
  return Math.round(((original - current) / original) * 100);
}

function roundSalePrice(value, rule = "nearest-pound") {
  const raw = number(value);
  if (!(raw > 0)) return 0;
  if (rule === "end-99") return money(Math.max(0.99, Math.floor(raw) + 0.99));
  if (rule === "preserve-pennies") return money(raw);
  return money(Math.max(1, Math.round(raw)));
}

function targetPriceForDiscount(price, discountPercent, rule = "nearest-pound") {
  return roundSalePrice(number(price) * (1 - clamp(discountPercent / 100, 0, 0.95)), rule);
}

function gpPercentFromRetail(retailPrice, costPrice) {
  const cost = costPrice == null || costPrice === "" ? NaN : Number(costPrice);
  const netRetail = number(retailPrice) / 1.2;
  if (!(netRetail > 0) || !Number.isFinite(cost)) return null;
  return Math.round((((netRetail - cost) / netRetail) * 100) * 10) / 10;
}

function isTargetBelowCost(retailPrice, costPrice) {
  const cost = costPrice == null || costPrice === "" ? NaN : Number(costPrice);
  const netRetail = number(retailPrice) / 1.2;
  return netRetail > 0 && Number.isFinite(cost) && netRetail < cost;
}

function parseSeasonYear(season) {
  const match = text(season).match(/\b(?:SS|AW)\s?(\d{2}|\d{4})\b/i);
  if (!match) return null;
  const year = Number(match[1]);
  return year < 100 ? 2000 + year : year;
}

function isOffSeason(product = {}, now = new Date()) {
  const season = text(product.season).toUpperCase();
  const seasonYear = parseSeasonYear(season);
  const currentYear = now.getUTCFullYear();
  if (seasonYear && seasonYear < currentYear) return true;
  if (!seasonYear || seasonYear > currentYear) return false;
  const month = now.getUTCMonth() + 1;
  if (season.includes("SS") && month >= 9) return true;
  if (season.includes("AW") && month >= 3 && month <= 7) return true;
  return false;
}

function saleSignals(product = {}, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const stock = Math.max(0, number(product.stock));
  const units = Math.max(0, number(product.units));
  const revenue = Math.max(0, number(product.revenue ?? product.rev));
  const price = originalPrice(product) || currentPrice(product);
  const coverWks = product.coverWks == null ? null : Math.max(0, number(product.coverWks));
  const sellThrough = units + stock > 0 ? units / (units + stock) : 0;
  const stockValue = stock * price;
  const age = daysBetween(product.publishedAt || product.createdAt || product.updatedAt, now);
  const existingMarkdown = currentMarkdownPercent(product);
  const offSeason = isOffSeason(product, now);
  const failedMarkdown = Boolean(product.failedMarkdown || product.markdownFailed || product.data?.failedMarkdown);
  const zeroSales = units <= 0 && revenue <= 0;
  const lowSales = units <= 2 || revenue <= price * 2;
  const stockDepth = clamp(stock / 50);
  const coverRisk = coverWks == null ? 0 : clamp((coverWks - 4) / 28);
  const sellThroughRisk = 1 - clamp(sellThrough / 0.35);
  const ageRisk = age == null ? 0.4 : clamp((age - 45) / 210);
  const valueRisk = clamp(stockValue / 1800);
  const seasonRisk = offSeason ? 1 : 0;
  const existingMarkdownRisk = existingMarkdown ? clamp((existingMarkdown - 10) / 40) : 0;
  const score = Math.round((
    stockDepth * 24 +
    coverRisk * 24 +
    sellThroughRisk * 18 +
    ageRisk * 14 +
    valueRisk * 12 +
    seasonRisk * 6 +
    existingMarkdownRisk * 2
  ));
  return {
    stock,
    units,
    revenue,
    price,
    currentPrice: currentPrice(product),
    originalPrice: price,
    compareAtPrice: number(product.compareAtPrice),
    cost: product.cost == null ? null : number(product.cost),
    coverWks,
    sellThrough,
    stockValue,
    ageDays: age,
    offSeason,
    zeroSales,
    lowSales,
    failedMarkdown,
    existingMarkdown,
    score
  };
}

function markdownStepForSignals(signals) {
  let step = 10;
  if (
    signals.stock >= 8 && (signals.lowSales || (signals.coverWks != null && signals.coverWks >= 8))
  ) step = 20;
  if (
    (signals.coverWks != null && signals.coverWks >= 12) ||
    (signals.units <= 1 && signals.stock >= 20) ||
    signals.stockValue >= 1000 ||
    signals.score >= 55
  ) step = 30;
  if (
    (signals.coverWks != null && signals.coverWks >= 24) ||
    (signals.zeroSales && signals.stock >= 30) ||
    (signals.ageDays != null && signals.ageDays >= 180 && signals.stock >= 12) ||
    (signals.offSeason && signals.stock >= 12) ||
    signals.score >= 72
  ) step = 40;
  if (
    (signals.coverWks != null && signals.coverWks >= 52) ||
    (signals.zeroSales && signals.stock >= 50 && (signals.ageDays == null || signals.ageDays >= 210)) ||
    (signals.failedMarkdown && signals.existingMarkdown >= 40) ||
    signals.score >= 88
  ) step = 50;
  return step;
}

function deepenExistingMarkdown(step, existingMarkdown) {
  if (!existingMarkdown) return step;
  const nextStep = DEFAULT_MARKDOWN_STEPS.find(candidate => candidate > existingMarkdown);
  return Math.max(step, nextStep || 50);
}

function recommendMarkdown(product = {}, options = {}) {
  const signals = saleSignals(product, options);
  const existing = signals.existingMarkdown;
  const step = deepenExistingMarkdown(markdownStepForSignals(signals), existing);
  const targetPrice = targetPriceForDiscount(signals.originalPrice, step, options.roundingRule || "nearest-pound");
  const warnings = [];
  if (step >= 50) warnings.push("Final-clearance markdown needs Admin confirmation.");
  if (isTargetBelowCost(targetPrice, signals.cost)) warnings.push("Target sale price is below variant cost.");
  if (!signals.originalPrice) warnings.push("Original price is missing.");
  return {
    discountPercent: step,
    targetPrice,
    originalPrice: money(signals.originalPrice),
    currentPrice: money(signals.currentPrice),
    existingMarkdownPercent: existing,
    riskScore: signals.score,
    stockValue: money(signals.stockValue),
    warnings,
    rationale: markdownRationale(signals, step)
  };
}

function markdownRationale(signals, step) {
  const reasons = [];
  if (signals.zeroSales) reasons.push("no recent sales");
  else if (signals.lowSales) reasons.push("weak recent demand");
  if (signals.coverWks != null && signals.coverWks >= 8) reasons.push(`${signals.coverWks.toFixed(1)} weeks cover`);
  if (signals.stock >= 20) reasons.push(`${Math.round(signals.stock)} units in stock`);
  if (signals.stockValue >= 1000) reasons.push(`high stock value`);
  if (signals.offSeason) reasons.push("off-season");
  if (signals.existingMarkdown) reasons.push(`${signals.existingMarkdown}% existing markdown`);
  return `${step}% recommended: ${reasons.slice(0, 4).join(", ") || "manual markdown review"}.`;
}

function variantSaleTargets(product = {}, discountPercent, options = {}) {
  const variants = Array.isArray(product.variants) && product.variants.length
    ? product.variants
    : [{ id: product.variantId || product.shopifyVariantId || "", sku: product.sku || "", price: product.price ?? product.rrp, compareAtPrice: product.compareAtPrice, cost: product.cost }];
  return variants.map(variant => {
    const original = originalPrice(variant);
    const target = targetPriceForDiscount(original, discountPercent, options.roundingRule || "nearest-pound");
    const cost = variant.cost == null || variant.cost === "" ? null : money(variant.cost);
    const warnings = [];
    if (!variant.id) warnings.push("Variant ID is missing.");
    if (!(original > 0)) warnings.push("Variant price is missing.");
    if (isTargetBelowCost(target, cost)) warnings.push("Target sale price is below variant cost.");
    return {
      id: text(variant.id),
      sku: text(variant.sku),
      title: text(variant.title),
      cost,
      originalPrice: money(original),
      currentPrice: money(currentPrice(variant)),
      targetPrice: target,
      compareAtPrice: money(original),
      discountPercent: number(discountPercent),
      targetGpPct: gpPercentFromRetail(target, cost),
      warnings
    };
  });
}

function removeSaleTargets(product = {}) {
  const variants = Array.isArray(product.variants) && product.variants.length
    ? product.variants
    : [{ id: product.variantId || product.shopifyVariantId || "", sku: product.sku || "", price: product.price ?? product.rrp, compareAtPrice: product.compareAtPrice }];
  return variants.map(variant => {
    const compareAt = number(variant.compareAtPrice);
    const current = currentPrice(variant);
    const restored = compareAt > 0 ? compareAt : current;
    const warnings = [];
    if (!variant.id) warnings.push("Variant ID is missing.");
    if (!(compareAt > 0)) warnings.push("No compare-at price found; current price will be left unchanged.");
    return {
      id: text(variant.id),
      sku: text(variant.sku),
      title: text(variant.title),
      restoredPrice: money(restored),
      previousPrice: money(current),
      compareAtPrice: compareAt > 0 ? money(compareAt) : null,
      warnings
    };
  });
}

function saleCollectionCandidates(collections = []) {
  const normalized = collections.map(collection => ({
    ...collection,
    key: normalizeKey(collection.handle || collection.title),
    titleKey: normalizeKey(collection.title),
    stem: pluralStem(collection.handle || collection.title)
  }));
  const rootSale = normalized.find(collection => collection.key === "sale" || collection.titleKey === "sale")
    || normalized.find(collection => /\bsale\b/i.test(text(collection.title)));
  const childCollections = normalized.filter(collection => collection.id !== rootSale?.id && (collection.key.startsWith("sale-") || collection.titleKey.startsWith("sale-")));
  return { rootSale, childCollections };
}

function matchSaleChildCollection(productType, collections = [], overrides = {}) {
  const manual = overrides[text(productType)] || overrides[normalizeKey(productType)] || overrides[pluralStem(productType)];
  if (manual) {
    const match = collections.find(collection => text(collection.id) === text(manual) || text(collection.handle) === text(manual));
    if (match) return { collection: match, source: "override" };
  }
  const typeKey = pluralStem(productType);
  const { childCollections } = saleCollectionCandidates(collections);
  const candidates = childCollections.map(collection => ({
    collection,
    keys: [
      normalizeKey(collection.handle || collection.title).replace(/^sale-/, ""),
      normalizeKey(collection.title).replace(/^sale-/, ""),
      pluralStem(collection.handle || collection.title).replace(/^sale-/, "")
    ]
  }));
  const match = candidates.find(candidate => candidate.keys.some(key => key === typeKey || key.includes(typeKey) || typeKey.includes(key)));
  return match ? { collection: match.collection, source: "auto" } : { collection: null, source: "" };
}

function collectionMembershipForProduct(product = {}, collections = [], overrides = {}) {
  const { rootSale } = saleCollectionCandidates(collections);
  const child = matchSaleChildCollection(product.productType || product.category || "", collections, overrides);
  return {
    rootSale: rootSale || null,
    childSale: child.collection || null,
    childSource: child.source,
    missing: [
      rootSale ? "" : "Root Sale collection not found.",
      child.collection ? "" : `Sale child collection not found for ${product.productType || product.category || "product type"}.`
    ].filter(Boolean)
  };
}

module.exports = {
  DEFAULT_MARKDOWN_STEPS,
  collectionMembershipForProduct,
  currentMarkdownPercent,
  daysBetween,
  gpPercentFromRetail,
  matchSaleChildCollection,
  money,
  normalizeKey,
  originalPrice,
  productKey,
  recommendMarkdown,
  removeSaleTargets,
  roundSalePrice,
  saleCollectionCandidates,
  saleSignals,
  targetPriceForDiscount,
  variantSaleTargets
};
