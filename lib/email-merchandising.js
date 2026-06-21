"use strict";

const OBJECTIVES = new Set(["balanced", "new_in", "underexposed", "never_featured", "proven"]);
const NEUTRALS = new Set(["black", "white", "cream", "ivory", "grey", "gray", "stone", "navy", "brown", "khaki", "denim"]);
const COHESION_STOP_WORDS = new Set(["the", "and", "with", "for", "from", "new", "product", "womens", "women", "ladies", "one", "size"]);

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function daysBetween(from, to = new Date()) {
  const value = new Date(from);
  if (!Number.isFinite(value.getTime())) return Infinity;
  return Math.max(0, Math.floor((to.getTime() - value.getTime()) / 864e5));
}

function productKey(product) {
  return String(product.id || product.legacyResourceId || product.handle || product.title || "");
}

function eligibility(product, options = {}) {
  const minimumStock = Math.max(1, Number(options.minimumStock || 3));
  const reasons = [];
  if (String(product.status || "").toUpperCase() !== "ACTIVE") reasons.push("Product is not live");
  if (!product.publishedAt) reasons.push("Product is not published");
  if (Number(product.stock || 0) < minimumStock) reasons.push(`Fewer than ${minimumStock} units available`);
  if (!product.imageUrl) reasons.push("Product image is missing");
  if (!(Number(product.price || 0) > 0)) reasons.push("Product price is missing");
  if (!product.onlineStoreUrl && !product.handle) reasons.push("Storefront URL is missing");
  return { eligible: reasons.length === 0, reasons };
}

function repeatState(lastFeaturedAt, now = new Date()) {
  if (!lastFeaturedAt) return { daysSinceFeatured: null, locked: false, multiplier: 1 };
  const days = daysBetween(lastFeaturedAt, now);
  if (days <= 28) return { daysSinceFeatured: days, locked: true, multiplier: 0 };
  if (days < 56) return { daysSinceFeatured: days, locked: false, multiplier: 0.35 + ((days - 28) / 28) * 0.65 };
  return { daysSinceFeatured: days, locked: false, multiplier: 1 };
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function textTokens(value) {
  return new Set(normalizedText(value).replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(token => token.length > 2 && !COHESION_STOP_WORDS.has(token)));
}

function productTokens(product) {
  return textTokens([product.title, product.productType, product.season, ...(product.tags || [])].join(" "));
}

function tokenSimilarity(a, b) {
  const left = productTokens(a);
  const right = productTokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function themeAffinity(product, theme) {
  const themeTokens = textTokens(theme);
  if (!themeTokens.size) return null;
  const tokens = productTokens(product);
  let matches = 0;
  for (const token of themeTokens) if (tokens.has(token) || normalizedText(product.color).includes(token)) matches += 1;
  return matches / themeTokens.size;
}

function objectiveScore(objective, signals) {
  if (objective === "new_in") return signals.newness * 0.55 + signals.stock * 0.2 + signals.margin * 0.15 + signals.conversion * 0.1;
  if (objective === "underexposed") return signals.lowViews * 0.4 + signals.conversion * 0.25 + signals.stock * 0.2 + signals.margin * 0.15;
  if (objective === "never_featured") return signals.neverFeatured * 0.5 + signals.stock * 0.2 + signals.commercial * 0.2 + signals.newness * 0.1;
  if (objective === "proven") return signals.commercial * 0.5 + signals.conversion * 0.2 + signals.stock * 0.15 + signals.margin * 0.15;
  return signals.commercial * 0.25 + signals.newness * 0.2 + signals.lowViews * 0.15 + signals.neverFeatured * 0.2 + signals.stock * 0.1 + signals.margin * 0.1;
}

function colourCompatibility(a, b) {
  const left = normalizedText(a);
  const right = normalizedText(b);
  if (!left || !right) return 0;
  if (left === right) return 0.03;
  if (NEUTRALS.has(left) || NEUTRALS.has(right)) return 0.08;
  return 0;
}

function cohesionScore(candidate, selected, theme) {
  const affinity = themeAffinity(candidate, theme);
  let score = affinity == null ? 0 : Math.min(0.2, affinity * 0.2);
  for (const other of selected) {
    if (candidate.season && candidate.season === other.season) score += 0.05;
    score += colourCompatibility(candidate.color, other.color);
    score += tokenSimilarity(candidate, other) * 0.14;
    if (candidate.productType && other.productType && candidate.productType === other.productType) score += 0.035;
    const high = Math.max(Number(candidate.price || 0), Number(other.price || 0));
    const low = Math.min(Number(candidate.price || 0), Number(other.price || 0));
    if (high && low / high >= 0.65) score += 0.025;
  }
  return selected.length ? score / selected.length : score;
}

function rationaleFor(objective, signals, repeat) {
  const labels = [];
  if (signals.newness >= 0.65) labels.push("recently launched");
  if (signals.lowViews >= 0.7) labels.push("underexposed");
  if (signals.neverFeatured) labels.push("not previously featured");
  if (signals.commercial >= 0.6) labels.push("commercially proven");
  if (signals.conversion >= 0.55) labels.push("strong conversion signal");
  if (!labels.length) labels.push(objective === "balanced" ? "balanced commercial opportunity" : "fits the campaign objective");
  if (repeat.daysSinceFeatured != null) labels.push(`last featured ${repeat.daysSinceFeatured} days ago`);
  return labels.slice(0, 3).join(", ");
}

function recommendProducts(products, history = {}, options = {}) {
  const objective = OBJECTIVES.has(options.objective) ? options.objective : "balanced";
  const count = Math.max(1, Math.min(6, Number(options.count || 6)));
  const now = options.now ? new Date(options.now) : new Date();
  const pinned = new Set((options.pinnedProductIds || []).map(String));
  const excluded = new Set((options.excludedProductIds || []).map(String));
  const maximums = {
    revenue: Math.max(1, ...products.map(product => Number(product.revenue || 0))),
    views: Math.max(1, ...products.map(product => Number(product.gaViews || 0))),
    stock: Math.max(1, ...products.map(product => Number(product.stock || 0))),
    conversion: Math.max(0.01, ...products.map(product => Number(product.gaViews || 0) ? Number(product.gaPurchases || product.units || 0) / Number(product.gaViews) : 0))
  };
  const all = products.map(product => {
    const key = productKey(product);
    const eligibleState = eligibility(product, options);
    const lastFeaturedAt = history[key] || history[String(product.legacyResourceId || "")] || null;
    const repeat = repeatState(lastFeaturedAt, now);
    const age = daysBetween(product.publishedAt || product.createdAt, now);
    const conversionRate = Number(product.gaViews || 0) ? Number(product.gaPurchases || product.units || 0) / Number(product.gaViews) : 0;
    const signals = {
      commercial: clamp(Number(product.revenue || 0) / maximums.revenue),
      views: clamp(Number(product.gaViews || 0) / maximums.views),
      lowViews: 1 - clamp(Number(product.gaViews || 0) / maximums.views),
      stock: clamp(Number(product.stock || 0) / maximums.stock),
      margin: product.margin == null ? 0.5 : clamp(Number(product.margin) / 100),
      conversion: clamp(conversionRate / maximums.conversion),
      newness: clamp(1 - age / 90),
      neverFeatured: lastFeaturedAt ? 0 : 1
    };
    const base = objectiveScore(objective, signals);
    return {
      ...product,
      productKey: key,
      eligibility: eligibleState,
      repeat,
      signals,
      baseScore: Math.round(base * repeat.multiplier * 1000) / 10,
      rationale: rationaleFor(objective, signals, repeat),
      pinned: pinned.has(key)
    };
  });
  const candidates = all.filter(product => product.eligibility.eligible && !product.repeat.locked && !excluded.has(product.productKey));
  const selected = [];
  const warnings = [];
  const canAdd = (product) => {
    if (selected.some(item => item.productKey === product.productKey)) return false;
    return true;
  };
  const ranked = (pool) => pool.slice().sort((a, b) => {
    const adjustedScore = product => {
      const typeCount = selected.filter(item => item.productType && item.productType === product.productType).length;
      const colourCount = selected.filter(item => item.color && normalizedText(item.color) === normalizedText(product.color)).length;
      const diversityPenalty = Math.max(0, typeCount - 1) * 8 + Math.max(0, colourCount - 1) * 6;
      const affinity = themeAffinity(product, options.theme);
      const themeMismatchPenalty = affinity === 0 ? 30 : 0;
      return product.baseScore * (selected.length ? 0.72 : 1) + cohesionScore(product, selected, options.theme) * 160 - diversityPenalty - themeMismatchPenalty;
    };
    const aScore = adjustedScore(a);
    const bScore = adjustedScore(b);
    return bScore - aScore || a.title.localeCompare(b.title) || a.productKey.localeCompare(b.productKey);
  });
  for (const product of ranked(candidates.filter(item => item.pinned))) {
    if (selected.length < count && canAdd(product)) selected.push(product);
  }
  while (selected.length < count) {
    const next = ranked(candidates.filter(product => canAdd(product)))[0];
    if (!next) break;
    selected.push(next);
  }
  const typeCounts = selected.reduce((map, product) => product.productType ? map.set(product.productType, (map.get(product.productType) || 0) + 1) : map, new Map());
  const colourCounts = selected.reduce((map, product) => { const colour = normalizedText(product.color); return colour ? map.set(colour, (map.get(colour) || 0) + 1) : map; }, new Map());
  if ([...typeCounts.values(), ...colourCounts.values()].some(value => value > 2)) warnings.push("A category or colour appears more than twice because it produced a more coherent capsule.");
  if (selected.length < count) warnings.push(`Only ${selected.length} eligible products are currently available.`);
  const finalProducts = selected.map((product, index) => ({
    ...product,
    position: index + 1,
    cohesionScore: Math.round(cohesionScore(product, selected.filter(item => item !== product), options.theme) * 1000) / 10,
    score: Math.round((product.baseScore + cohesionScore(product, selected.filter(item => item !== product), options.theme) * 100) * 10) / 10
  }));
  return {
    objective,
    products: finalProducts,
    replacements: ranked(candidates.filter(product => !selected.some(item => item.productKey === product.productKey))),
    ineligible: all.filter(product => !product.eligibility.eligible || product.repeat.locked),
    warnings
  };
}

function trackedProductUrl(product, campaignCode, position, storefrontUrl = "") {
  const base = product.onlineStoreUrl || (product.handle && storefrontUrl ? `${String(storefrontUrl).replace(/\/$/, "")}/products/${encodeURIComponent(product.handle)}` : "");
  if (!base) return "";
  const url = new URL(base);
  url.searchParams.set("utm_source", "klaviyo");
  url.searchParams.set("utm_medium", "email");
  url.searchParams.set("utm_campaign", campaignCode);
  url.searchParams.set("utm_content", `slot-${position}-${productKey(product).replace(/[^a-z0-9]+/gi, "-").slice(-40)}`);
  return url.toString();
}

module.exports = { OBJECTIVES, cohesionScore, daysBetween, eligibility, productKey, recommendProducts, repeatState, trackedProductUrl };
