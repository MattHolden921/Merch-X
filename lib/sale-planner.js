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
  const explicitOriginal = number(product.saleOriginalPrice ?? product.originalRrp ?? product.rrpOriginal ?? product.fullPrice ?? product.originalPrice);
  if (explicitOriginal > 0) return explicitOriginal;
  const price = number(product.price ?? product.currentPrice ?? product.rrp);
  const compareAt = number(product.compareAtPrice);
  return compareAt > price && price > 0 ? compareAt : price;
}

function currentPrice(product = {}) {
  return number(product.price ?? product.currentPrice ?? product.rrp ?? product.originalPrice);
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

function similarMarkdownOutcome(product = {}, outcome = {}) {
  const type = normalizeKey(product.productType || product.category || "");
  const outcomeType = normalizeKey(outcome.productType || outcome.category || "");
  if (type && outcomeType && type !== outcomeType) return false;
  const productSeason = text(product.season).slice(0, 4).toUpperCase();
  const outcomeSeason = text(outcome.season).slice(0, 4).toUpperCase();
  return !productSeason || !outcomeSeason || productSeason === outcomeSeason;
}

function markdownLearningStep(product = {}, baseStep, outcomes = []) {
  const step = number(baseStep);
  const similar = (outcomes || []).filter(outcome => similarMarkdownOutcome(product, outcome));
  if (!similar.length) return step;
  const worked = new Set(["worked", "remove"]);
  const failedAtOrBelow = similar.filter(outcome => (
    ["deepen", "failed"].includes(text(outcome.outcome).toLowerCase()) &&
    number(outcome.discountPercent) <= step
  ));
  const deeperWorked = similar.filter(outcome => worked.has(text(outcome.outcome).toLowerCase()) && number(outcome.discountPercent) > step);
  if (failedAtOrBelow.length && deeperWorked.length) {
    return DEFAULT_MARKDOWN_STEPS.find(candidate => candidate > step) || step;
  }
  const lighterWorked = similar.filter(outcome => worked.has(text(outcome.outcome).toLowerCase()) && number(outcome.discountPercent) < step);
  if (lighterWorked.length >= 2 && !failedAtOrBelow.length) {
    const previous = [...DEFAULT_MARKDOWN_STEPS].reverse().find(candidate => candidate < step);
    return previous || step;
  }
  return step;
}

function recommendMarkdown(product = {}, options = {}) {
  const signals = saleSignals(product, options);
  const existing = signals.existingMarkdown;
  const baseStep = deepenExistingMarkdown(markdownStepForSignals(signals), existing);
  const step = markdownLearningStep(product, baseStep, options.markdownOutcomes || options.learningOutcomes || []);
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
    const compareAt = number(variant.saleOriginalPrice ?? variant.originalRrp ?? variant.rrpOriginal ?? variant.originalPrice ?? variant.compareAtPrice);
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

function analysisRate(numerator, denominator) {
  const den = number(denominator);
  if (!(den > 0)) return 0;
  return number(numerator) / den;
}

function markdownOutcome(input = {}) {
  const preUnits = Math.max(0, number(input.preUnits));
  const preStock = Math.max(0, number(input.preStock));
  const postUnits = Math.max(0, number(input.postUnits));
  const postStock = Math.max(0, number(input.postStock));
  const daysObserved = Math.max(0, number(input.daysObserved));
  const startStock = Math.max(preStock + preUnits, number(input.startStock || input.originalStock));
  const stockReduction = startStock > 0 ? clamp((startStock - postStock) / startStock, 0, 1) : 0;
  const preSellThrough = analysisRate(preUnits, preUnits + preStock);
  const postSellThrough = analysisRate(postUnits, postUnits + postStock);
  const preCvr = analysisRate(input.preGaPurchases ?? preUnits, input.preGaViews);
  const postCvr = analysisRate(input.postGaPurchases ?? postUnits, input.postGaViews);
  const sellThroughLift = postSellThrough - preSellThrough;
  const cvrLift = postCvr - preCvr;
  const early = daysObserved > 0 && daysObserved < 14;
  let outcome = "watch";
  let reason = "Mixed or early markdown signal.";
  if (postStock <= 0 || stockReduction >= 0.8) {
    outcome = "remove";
    reason = "Stock is cleared or materially reduced.";
  } else if (early) {
    outcome = "watch";
    reason = "Early read; keep monitoring before changing the markdown.";
  } else if (sellThroughLift >= 0.08 || cvrLift >= 0.01 || (postSellThrough >= preSellThrough * 1.5 && postSellThrough >= 0.1)) {
    outcome = "worked";
    reason = "Sell-through or GA CVR improved after markdown.";
  } else if (daysObserved >= 21 && postStock > 0) {
    outcome = "deepen";
    reason = "Markdown has not lifted demand enough and stock remains.";
  }
  return {
    outcome,
    reason,
    early,
    preSellThrough: Math.round(preSellThrough * 1000) / 1000,
    postSellThrough: Math.round(postSellThrough * 1000) / 1000,
    sellThroughLift: Math.round(sellThroughLift * 1000) / 1000,
    preCvr: Math.round(preCvr * 1000) / 1000,
    postCvr: Math.round(postCvr * 1000) / 1000,
    cvrLift: Math.round(cvrLift * 1000) / 1000,
    stockReduction: Math.round(stockReduction * 1000) / 1000,
    daysObserved
  };
}

function nextMarkdownStep(currentDiscount) {
  const current = number(currentDiscount);
  return DEFAULT_MARKDOWN_STEPS.find(candidate => candidate > current) || 50;
}

function lowViewSignal(input = {}, options = {}) {
  const daysObserved = Math.max(0, number(input.daysObserved));
  const postStock = Math.max(0, number(input.postStock));
  const postViews = Math.max(0, number(input.postGaViews));
  const minDays = Math.max(1, number(options.minDays, 7));
  const minViewsPerWeek = Math.max(1, number(options.minViewsPerWeek, 25));
  const weeks = Math.max(daysObserved / 7, 1);
  const viewsPerWeek = postViews / weeks;
  return {
    lowViews: daysObserved >= minDays && postStock > 0 && viewsPerWeek < minViewsPerWeek,
    viewsPerWeek: Math.round(viewsPerWeek * 10) / 10,
    minViewsPerWeek,
    daysObserved,
    postViews,
    postStock
  };
}

function markdownActionRecommendation(outcome = {}, item = {}, options = {}) {
  const originalPriceValue = number(item.originalPrice || outcome.data?.originalPrice);
  const currentPriceValue = number(item.currentPrice || outcome.data?.currentPrice);
  const currentDiscount = number(item.discountPercent || outcome.discountPercent);
  const lowViews = lowViewSignal(outcome, options.lowViews || options);
  if (lowViews.lowViews && !["remove"].includes(text(outcome.outcome).toLowerCase())) {
    return {
      actionType: "low_views",
      label: "Low views",
      priority: "Medium",
      currentDiscountPercent: currentDiscount,
      recommendedDiscountPercent: currentDiscount,
      currentPrice: money(currentPriceValue),
      recommendedTargetPrice: money(currentPriceValue),
      originalPrice: money(originalPriceValue),
      reason: `Only ${lowViews.viewsPerWeek} views/week since markdown; review exposure before another price cut.`,
      data: { lowViews }
    };
  }
  if (text(outcome.outcome).toLowerCase() === "deepen") {
    const recommendedDiscount = nextMarkdownStep(currentDiscount);
    return {
      actionType: "deepen",
      label: "Deepen markdown",
      priority: recommendedDiscount >= 50 ? "High" : "Medium",
      currentDiscountPercent: currentDiscount,
      recommendedDiscountPercent: recommendedDiscount,
      currentPrice: money(currentPriceValue),
      recommendedTargetPrice: targetPriceForDiscount(originalPriceValue, recommendedDiscount, options.roundingRule || "nearest-pound"),
      originalPrice: money(originalPriceValue),
      reason: outcome.reason || "Markdown has not lifted demand enough and stock remains.",
      data: {}
    };
  }
  if (text(outcome.outcome).toLowerCase() === "remove") {
    return {
      actionType: "remove",
      label: "Remove from sale",
      priority: "High",
      currentDiscountPercent: currentDiscount,
      recommendedDiscountPercent: 0,
      currentPrice: money(currentPriceValue),
      recommendedTargetPrice: money(originalPriceValue || currentPriceValue),
      originalPrice: money(originalPriceValue || currentPriceValue),
      reason: outcome.reason || "Sale objective met; restore the product.",
      data: {}
    };
  }
  return null;
}

module.exports = {
  DEFAULT_MARKDOWN_STEPS,
  collectionMembershipForProduct,
  currentMarkdownPercent,
  daysBetween,
  gpPercentFromRetail,
  matchSaleChildCollection,
  markdownLearningStep,
  markdownActionRecommendation,
  markdownOutcome,
  lowViewSignal,
  money,
  nextMarkdownStep,
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
