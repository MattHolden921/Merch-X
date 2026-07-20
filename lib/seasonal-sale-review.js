"use strict";

const salePlanner = require("./sale-planner");

const DECISIONS = new Set([
  "undecided",
  "first_drop",
  "second_drop",
  "hold",
  "carry_forward",
  "exclude",
  "needs_data"
]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoDate(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
}

function daysBetween(from, to) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : new Date();
  if (!start || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 864e5));
}

function gaConversion(product = {}) {
  const views = Math.max(0, number(product.gaViews));
  const purchases = Math.max(0, number(product.gaPurchases));
  return {
    views,
    purchases,
    cvr: views > 0 ? purchases / views : null
  };
}

function decisionLabel(value) {
  return {
    undecided: "Undecided",
    first_drop: "First drop",
    second_drop: "Second drop",
    hold: "Hold full price",
    carry_forward: "Carry forward",
    exclude: "Exclude",
    needs_data: "Needs data"
  }[value] || "Undecided";
}

function normalizeDecision(value) {
  const clean = String(value || "").trim().toLowerCase();
  return DECISIONS.has(clean) ? clean : "undecided";
}

function currentOriginalPrice(product = {}) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const originals = variants.map(variant => salePlanner.originalPrice(variant)).filter(value => value > 0);
  return originals.length ? Math.max(...originals) : salePlanner.originalPrice(product);
}

function stockRetailValue(product = {}) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (variants.length) {
    return Math.round(variants.reduce((sum, variant) => (
      sum + Math.max(0, number(variant.inventoryQuantity)) * salePlanner.originalPrice(variant)
    ), 0) * 100) / 100;
  }
  return Math.round(Math.max(0, number(product.stock)) * currentOriginalPrice(product) * 100) / 100;
}

function productDataIssues(product = {}, liveAt = "") {
  const issues = [];
  if (!String(product.id || "").startsWith("gid://shopify/Product/")) issues.push("Shopify product ID is missing.");
  if (!String(product.season || "").trim()) issues.push("Season is missing.");
  if (!currentOriginalPrice(product)) issues.push("Original retail price is missing.");
  if (!Array.isArray(product.variants) || !product.variants.length) issues.push("Variant data is missing.");
  if (String(product.status || product.shopifyStatus || "").toUpperCase() === "ACTIVE" && !liveAt) issues.push("Live date is missing.");
  return issues;
}

function reviewRecommendation(product = {}, options = {}) {
  const minLiveDays = Math.max(0, number(options.minLiveDays, 28));
  const minGaViews = Math.max(1, number(options.minGaViews, 30));
  const lowGaCvr = Math.max(0, number(options.lowGaCvr, 0.01));
  const strongGaCvr = Math.max(lowGaCvr, number(options.strongGaCvr, 0.03));
  const asOf = options.asOf || new Date();
  const liveAt = isoDate(product.liveAt || product.publishedAt);
  const activeDays = daysBetween(liveAt, asOf);
  const stock = Math.max(0, number(product.stock));
  const status = String(product.status || product.shopifyStatus || "").toUpperCase();
  const ga = gaConversion(product);
  const issues = productDataIssues(product, liveAt);
  const markdown = salePlanner.recommendMarkdown(product, {
    now: asOf,
    roundingRule: options.roundingRule || "nearest-pound",
    markdownOutcomes: options.markdownOutcomes || []
  });
  let candidateScore = markdown.riskScore;
  const reasons = [];

  if (ga.views >= minGaViews && ga.cvr != null && ga.cvr < lowGaCvr) {
    candidateScore += 10;
    reasons.push(`Low GA CVR (${(ga.cvr * 100).toFixed(1)}%) from ${Math.round(ga.views)} views.`);
  } else if (ga.views >= minGaViews && ga.cvr != null && ga.cvr >= strongGaCvr) {
    candidateScore -= 10;
    reasons.push(`Strong GA CVR (${(ga.cvr * 100).toFixed(1)}%) supports holding price.`);
  } else if (ga.views < minGaViews) {
    reasons.push(`GA CVR has insufficient traffic (${Math.round(ga.views)} of ${minGaViews} minimum views).`);
  }
  candidateScore = Math.max(0, Math.min(100, Math.round(candidateScore)));

  let suggestedDecision = "hold";
  if (status !== "ACTIVE") {
    suggestedDecision = "hold";
    reasons.unshift("Product is not currently active on Shopify.");
  } else if (stock <= 0) {
    suggestedDecision = "exclude";
    reasons.unshift("No current stock is available for sale.");
  } else if (issues.some(issue => /Live date|Shopify product ID|Original retail|Variant data/.test(issue))) {
    suggestedDecision = "needs_data";
    reasons.unshift("Resolve blocking product data before assigning a sale drop.");
  } else if (activeDays != null && activeDays < minLiveDays) {
    suggestedDecision = "hold";
    reasons.unshift(`Protected as a recent launch: live ${activeDays} days, below the ${minLiveDays}-day minimum.`);
  } else if (candidateScore >= 55) {
    suggestedDecision = "first_drop";
    reasons.unshift(markdown.rationale);
  } else if (candidateScore >= 20) {
    suggestedDecision = "second_drop";
    reasons.unshift(`${markdown.rationale} Review again for the second drop.`);
  } else {
    suggestedDecision = "hold";
    reasons.unshift(`${markdown.rationale} Current risk does not require the first drop.`);
  }

  return {
    suggestedDecision,
    suggestedDecisionLabel: decisionLabel(suggestedDecision),
    candidateScore,
    activeDays,
    liveAt,
    protectedRecentLaunch: activeDays != null && activeDays < minLiveDays,
    gaViews: ga.views,
    gaPurchases: ga.purchases,
    gaCvr: ga.cvr,
    gaSignalAvailable: ga.views >= minGaViews,
    dataIssues: issues,
    reasons,
    markdown
  };
}

function reviewSummary(items = []) {
  const emptyDropStats = () => ({
    products: 0,
    stockUnits: 0,
    stockRetailValue: 0,
    markdownInvestment: 0,
    avgDiscountPercent: null
  });
  const summary = {
    products: items.length,
    reviewed: 0,
    firstDrop: 0,
    secondDrop: 0,
    hold: 0,
    carryForward: 0,
    exclude: 0,
    needsData: 0,
    protectedRecentLaunches: 0,
    stockUnits: 0,
    stockRetailValue: 0,
    gaViews: 0,
    gaPurchases: 0,
    gaCvr: null,
    firstDropStats: emptyDropStats(),
    secondDropStats: emptyDropStats(),
    notInDropStats: emptyDropStats()
  };
  for (const item of items) {
    const decision = normalizeDecision(item.decision);
    if (decision !== "undecided") summary.reviewed += 1;
    if (decision === "first_drop") summary.firstDrop += 1;
    if (decision === "second_drop") summary.secondDrop += 1;
    if (decision === "hold") summary.hold += 1;
    if (decision === "carry_forward") summary.carryForward += 1;
    if (decision === "exclude") summary.exclude += 1;
    if (decision === "needs_data") summary.needsData += 1;
    if (item.protectedRecentLaunch) summary.protectedRecentLaunches += 1;
    summary.stockUnits += Math.max(0, number(item.stock));
    summary.stockRetailValue += Math.max(0, number(item.stockRetailValue));
    summary.gaViews += Math.max(0, number(item.fullGaViews ?? item.gaViews));
    summary.gaPurchases += Math.max(0, number(item.fullGaPurchases ?? item.gaPurchases));
    const decisionStats = decision === "first_drop"
      ? summary.firstDropStats
      : decision === "second_drop" ? summary.secondDropStats : summary.notInDropStats;
    const stockUnits = Math.max(0, number(item.stock));
    const stockRetailValue = Math.max(0, number(item.stockRetailValue));
    const discountPercent = Math.min(100, Math.max(0, number(item.metrics?.discountPercent)));
    decisionStats.products += 1;
    decisionStats.stockUnits += stockUnits;
    decisionStats.stockRetailValue += stockRetailValue;
    decisionStats.markdownInvestment += stockRetailValue * discountPercent / 100;
  }
  summary.stockRetailValue = Math.round(summary.stockRetailValue * 100) / 100;
  summary.gaCvr = summary.gaViews > 0 ? summary.gaPurchases / summary.gaViews : null;
  for (const dropStats of [summary.firstDropStats, summary.secondDropStats, summary.notInDropStats]) {
    dropStats.stockRetailValue = Math.round(dropStats.stockRetailValue * 100) / 100;
    dropStats.markdownInvestment = Math.round(dropStats.markdownInvestment * 100) / 100;
    dropStats.avgDiscountPercent = dropStats.stockRetailValue > 0
      ? Math.round((dropStats.markdownInvestment / dropStats.stockRetailValue) * 1000) / 10
      : null;
  }
  return summary;
}

module.exports = {
  DECISIONS,
  daysBetween,
  decisionLabel,
  gaConversion,
  normalizeDecision,
  productDataIssues,
  reviewRecommendation,
  reviewSummary,
  stockRetailValue
};
