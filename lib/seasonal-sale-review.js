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

function addDays(value, days) {
  const start = value ? new Date(`${isoDate(value)}T00:00:00.000Z`) : null;
  if (!start || !Number.isFinite(start.getTime())) return "";
  return new Date(start.getTime() + number(days) * 864e5).toISOString().slice(0, 10);
}

function weeksBetween(from, to) {
  const start = from ? new Date(`${isoDate(from)}T00:00:00.000Z`) : null;
  const end = to ? new Date(`${isoDate(to)}T00:00:00.000Z`) : null;
  if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  return Math.max(0, (end.getTime() - start.getTime()) / (7 * 864e5));
}

function forecastOptions(options = {}) {
  const asOf = isoDate(options.asOf || new Date());
  const firstDropDate = isoDate(options.firstDropDate) || asOf;
  const secondDropDate = isoDate(options.secondDropDate) || addDays(firstDropDate, 21);
  const seasonEndDate = isoDate(options.seasonEndDate) || addDays(secondDropDate, 51);
  return {
    firstDropDate,
    secondDropDate: secondDropDate < firstDropDate ? firstDropDate : secondDropDate,
    seasonEndDate: seasonEndDate < secondDropDate ? secondDropDate : seasonEndDate,
    recentWeeks: Math.max(1 / 7, number(options.recentWeeks, 4)),
    targetRemainingPct: Math.min(100, Math.max(0, number(options.targetRemainingPct, 10))),
    firstDropUplift: Math.min(10, Math.max(1, number(options.firstDropUplift, 2))),
    secondDropUplift: Math.min(10, Math.max(1, number(options.secondDropUplift, 3))),
    maxSecondDropSharePct: Math.min(100, Math.max(0, number(options.maxSecondDropSharePct, 25)))
  };
}

function clearanceForecast(product = {}, options = {}) {
  const plan = forecastOptions(options);
  const stock = Math.max(0, number(product.stock));
  const recentUnits = Math.max(0, number(product.units ?? product.recentUnits));
  const weeklyRunRate = recentUnits / plan.recentWeeks;
  const secondBoundary = plan.secondDropDate < plan.seasonEndDate ? plan.secondDropDate : plan.seasonEndDate;
  const preSecondWeeks = weeksBetween(plan.firstDropDate, secondBoundary);
  const postSecondWeeks = weeksBetween(secondBoundary, plan.seasonEndDate);
  const fullPriceWeeks = weeksBetween(plan.firstDropDate, plan.seasonEndDate);
  const targetEndStock = stock * plan.targetRemainingPct / 100;
  const fullPriceProjectedUnits = weeklyRunRate * fullPriceWeeks;
  const secondDropProjectedUnits = weeklyRunRate * preSecondWeeks
    + weeklyRunRate * plan.secondDropUplift * postSecondWeeks;
  const firstDropProjectedUnits = weeklyRunRate * plan.firstDropUplift * preSecondWeeks
    + weeklyRunRate * plan.secondDropUplift * postSecondWeeks;
  const projectedStock = units => Math.max(0, stock - units);
  const fullPriceProjectedEndStock = projectedStock(fullPriceProjectedUnits);
  const secondDropProjectedEndStock = projectedStock(secondDropProjectedUnits);
  const firstDropProjectedEndStock = projectedStock(firstDropProjectedUnits);
  const round = value => Math.round(number(value) * 100) / 100;
  return {
    ...plan,
    stock: round(stock),
    recentUnits: round(recentUnits),
    weeklyRunRate: round(weeklyRunRate),
    preSecondWeeks: round(preSecondWeeks),
    postSecondWeeks: round(postSecondWeeks),
    fullPriceWeeks: round(fullPriceWeeks),
    targetEndStock: round(targetEndStock),
    fullPriceProjectedUnits: round(fullPriceProjectedUnits),
    secondDropProjectedUnits: round(secondDropProjectedUnits),
    firstDropProjectedUnits: round(firstDropProjectedUnits),
    fullPriceProjectedEndStock: round(fullPriceProjectedEndStock),
    secondDropProjectedEndStock: round(secondDropProjectedEndStock),
    firstDropProjectedEndStock: round(firstDropProjectedEndStock),
    fullPriceClearanceGap: round(Math.max(0, fullPriceProjectedEndStock - targetEndStock)),
    secondDropClearanceGap: round(Math.max(0, secondDropProjectedEndStock - targetEndStock)),
    firstDropClearanceGap: round(Math.max(0, firstDropProjectedEndStock - targetEndStock)),
    noRecentSales: recentUnits <= 0,
    canClearAtFullPrice: fullPriceProjectedEndStock <= targetEndStock + 0.005,
    canWaitForSecondDrop: secondDropProjectedEndStock <= targetEndStock + 0.005,
    canClearFromFirstDrop: firstDropProjectedEndStock <= targetEndStock + 0.005,
    promotedByPortfolio: false
  };
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
  const forecast = clearanceForecast(product, options);
  let candidateScore = stock > 0
    ? Math.round(Math.max(0, forecast.fullPriceProjectedEndStock - forecast.targetEndStock) / stock * 100)
    : 0;
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
  } else if (forecast.canClearAtFullPrice) {
    suggestedDecision = "hold";
    reasons.unshift(`Current run rate projects ${forecast.fullPriceProjectedEndStock.toFixed(1)} units at season end, within the ${forecast.targetEndStock.toFixed(1)}-unit target.`);
  } else if (forecast.canWaitForSecondDrop) {
    suggestedDecision = "second_drop";
    reasons.unshift(`Safe to wait: a second-drop launch projects ${forecast.secondDropProjectedEndStock.toFixed(1)} units at season end, within the ${forecast.targetEndStock.toFixed(1)}-unit target.`);
  } else {
    suggestedDecision = "first_drop";
    if (forecast.noRecentSales) {
      reasons.unshift(`No sales in the recent window; waiting projects all ${Math.round(stock)} units remaining at season end.`);
    } else if (forecast.canClearFromFirstDrop) {
      reasons.unshift(`Needs the first drop: waiting projects ${forecast.secondDropProjectedEndStock.toFixed(1)} units at season end versus a ${forecast.targetEndStock.toFixed(1)}-unit target.`);
    } else {
      reasons.unshift(`First-drop shortfall: even an early launch projects ${forecast.firstDropProjectedEndStock.toFixed(1)} units at season end versus a ${forecast.targetEndStock.toFixed(1)}-unit target.`);
    }
  }
  reasons.push(markdown.rationale);

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
    markdown,
    forecast
  };
}

function allocateDropPortfolio(items = [], options = {}) {
  const plan = forecastOptions(options);
  const rows = items.map(item => ({
    ...item,
    reasons: [...(item.reasons || [])],
    metrics: { ...(item.metrics || {}), forecast: { ...(item.metrics?.forecast || {}) } }
  }));
  const planned = rows.filter(item => ["first_drop", "second_drop"].includes(item.suggestedDecision));
  const weight = item => Math.max(0, number(item.stockRetailValue)) || Math.max(0, number(item.stock));
  const totalWeight = planned.reduce((sum, item) => sum + weight(item), 0);
  const secondLimit = totalWeight * plan.maxSecondDropSharePct / 100;
  const secondCandidates = rows.filter(item => item.suggestedDecision === "second_drop").sort((left, right) => {
    const leftForecast = left.metrics?.forecast || {};
    const rightForecast = right.metrics?.forecast || {};
    const leftSafety = number(leftForecast.targetEndStock) - number(leftForecast.secondDropProjectedEndStock);
    const rightSafety = number(rightForecast.targetEndStock) - number(rightForecast.secondDropProjectedEndStock);
    return rightSafety - leftSafety || number(left.candidateScore) - number(right.candidateScore);
  });
  let retainedWeight = 0;
  const retained = new Set();
  for (const item of secondCandidates) {
    const itemWeight = weight(item);
    if (retainedWeight + itemWeight <= secondLimit + 0.005) {
      retained.add(item.id || item.productKey);
      retainedWeight += itemWeight;
    }
  }
  for (const item of secondCandidates) {
    if (retained.has(item.id || item.productKey)) continue;
    item.suggestedDecision = "first_drop";
    item.metrics.forecast.promotedByPortfolio = true;
    item.reasons.unshift(`Moved to First Drop so Second Drop stays within ${plan.maxSecondDropSharePct.toFixed(0)}% of planned stock at RRP.`);
  }
  return rows;
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
    notInDropStats: emptyDropStats(),
    suggestedAllocation: {
      firstDrop: { ...emptyDropStats(), projectedEndStock: 0, targetEndStock: 0, expectedUnits: 0, shortfallProducts: 0 },
      secondDrop: { ...emptyDropStats(), projectedEndStock: 0, targetEndStock: 0, expectedUnits: 0, shortfallProducts: 0 },
      hold: { ...emptyDropStats(), projectedEndStock: 0, targetEndStock: 0, expectedUnits: 0, shortfallProducts: 0 },
      other: { ...emptyDropStats(), projectedEndStock: 0, targetEndStock: 0, expectedUnits: 0, shortfallProducts: 0 }
    }
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

    const suggestionKey = item.suggestedDecision === "first_drop" ? "firstDrop"
      : item.suggestedDecision === "second_drop" ? "secondDrop"
        : item.suggestedDecision === "hold" ? "hold" : "other";
    const suggestionStats = summary.suggestedAllocation[suggestionKey];
    const forecast = item.metrics?.forecast || {};
    const projectedEndStock = suggestionKey === "firstDrop" ? number(forecast.firstDropProjectedEndStock)
      : suggestionKey === "secondDrop" ? number(forecast.secondDropProjectedEndStock)
        : number(forecast.fullPriceProjectedEndStock);
    const expectedUnits = suggestionKey === "firstDrop" ? number(forecast.firstDropProjectedUnits)
      : suggestionKey === "secondDrop" ? number(forecast.secondDropProjectedUnits)
        : number(forecast.fullPriceProjectedUnits);
    suggestionStats.products += 1;
    suggestionStats.stockUnits += stockUnits;
    suggestionStats.stockRetailValue += stockRetailValue;
    suggestionStats.markdownInvestment += stockRetailValue * discountPercent / 100;
    suggestionStats.projectedEndStock += projectedEndStock;
    suggestionStats.targetEndStock += number(forecast.targetEndStock);
    suggestionStats.expectedUnits += Math.min(stockUnits, expectedUnits);
    if (projectedEndStock > number(forecast.targetEndStock) + 0.005) suggestionStats.shortfallProducts += 1;
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
  for (const stats of Object.values(summary.suggestedAllocation)) {
    for (const key of ["stockRetailValue", "markdownInvestment", "projectedEndStock", "targetEndStock", "expectedUnits"]) {
      stats[key] = Math.round(number(stats[key]) * 100) / 100;
    }
    stats.avgDiscountPercent = stats.stockRetailValue > 0
      ? Math.round((stats.markdownInvestment / stats.stockRetailValue) * 1000) / 10
      : null;
  }
  return summary;
}

module.exports = {
  DECISIONS,
  allocateDropPortfolio,
  clearanceForecast,
  daysBetween,
  decisionLabel,
  forecastOptions,
  gaConversion,
  normalizeDecision,
  productDataIssues,
  reviewRecommendation,
  reviewSummary,
  stockRetailValue
};
