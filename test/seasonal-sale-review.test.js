"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allocateDropPortfolio,
  clearanceForecast,
  gaConversion,
  normalizeDecision,
  reviewRecommendation,
  reviewSummary,
  stockRetailValue
} = require("../lib/seasonal-sale-review");

function product(overrides = {}) {
  return {
    id: "gid://shopify/Product/1",
    status: "ACTIVE",
    season: "SS26",
    publishedAt: "2026-04-01T09:00:00Z",
    price: 50,
    stock: 30,
    units: 0,
    revenue: 0,
    coverWks: 30,
    gaViews: 100,
    gaPurchases: 1,
    variants: [{ id: "gid://shopify/ProductVariant/1", price: 50, inventoryQuantity: 30, cost: 15 }],
    ...overrides
  };
}

test("calculates GA CVR from GA purchases rather than Shopify units", () => {
  assert.deepEqual(gaConversion({ gaViews: 200, gaPurchases: 6, units: 20 }), {
    views: 200,
    purchases: 6,
    cvr: 0.03
  });
});

test("protects recent live products from automatic sale selection", () => {
  const result = reviewRecommendation(product({ publishedAt: "2026-07-10T09:00:00Z" }), {
    asOf: "2026-07-20T12:00:00Z",
    minLiveDays: 28
  });
  assert.equal(result.suggestedDecision, "hold");
  assert.equal(result.protectedRecentLaunch, true);
  assert.match(result.reasons[0], /recent launch/i);
});

test("uses forecasted first and second drops after live-date protection", () => {
  const first = reviewRecommendation(product(), { asOf: "2026-07-20T12:00:00Z" });
  assert.equal(first.suggestedDecision, "first_drop");

  const second = reviewRecommendation(product({ stock: 8, units: 2, coverWks: 8, gaViews: 10, gaPurchases: 0 }), {
    asOf: "2026-07-20T12:00:00Z"
  });
  assert.equal(second.suggestedDecision, "second_drop");
});

test("forecasts drops from season-end clearance rather than fixed score bands", () => {
  const options = {
    asOf: "2026-07-20T12:00:00Z",
    firstDropDate: "2026-07-27",
    secondDropDate: "2026-08-10",
    seasonEndDate: "2026-09-30",
    recentWeeks: 4,
    targetRemainingPct: 10,
    firstDropUplift: 2,
    secondDropUplift: 3
  };
  const zeroSeller = reviewRecommendation(product({ stock: 20, units: 0, gaViews: 10 }), options);
  assert.equal(zeroSeller.suggestedDecision, "first_drop");
  assert.equal(zeroSeller.forecast.noRecentSales, true);
  assert.equal(zeroSeller.forecast.firstDropProjectedEndStock, 20);

  const safeToWait = reviewRecommendation(product({ stock: 20, units: 4, gaViews: 10 }), options);
  assert.equal(safeToWait.suggestedDecision, "second_drop");
  assert.equal(safeToWait.forecast.canWaitForSecondDrop, true);

  const clearsAtFullPrice = reviewRecommendation(product({ stock: 5, units: 8, gaViews: 10 }), options);
  assert.equal(clearsAtFullPrice.suggestedDecision, "hold");
  assert.equal(clearsAtFullPrice.forecast.canClearAtFullPrice, true);
});

test("portfolio allocation caps second drop stock value and promotes the least safe rows", () => {
  const baseForecast = { targetEndStock: 2, secondDropProjectedEndStock: 1 };
  const rows = [
    { id: "first", suggestedDecision: "first_drop", stock: 10, stockRetailValue: 600, reasons: [], metrics: { forecast: baseForecast } },
    { id: "safe", suggestedDecision: "second_drop", stock: 5, stockRetailValue: 200, candidateScore: 10, reasons: [], metrics: { forecast: { targetEndStock: 2, secondDropProjectedEndStock: 0 } } },
    { id: "borderline", suggestedDecision: "second_drop", stock: 5, stockRetailValue: 200, candidateScore: 30, reasons: [], metrics: { forecast: { targetEndStock: 2, secondDropProjectedEndStock: 1.9 } } }
  ];
  const allocated = allocateDropPortfolio(rows, { maxSecondDropSharePct: 25 });
  assert.equal(allocated.find(row => row.id === "safe").suggestedDecision, "second_drop");
  assert.equal(allocated.find(row => row.id === "borderline").suggestedDecision, "first_drop");
  assert.equal(allocated.find(row => row.id === "borderline").metrics.forecast.promotedByPortfolio, true);
});

test("clearance forecast exposes run rate, scenarios, and target stock", () => {
  const forecast = clearanceForecast(product({ stock: 40, units: 4 }), {
    firstDropDate: "2026-07-27", secondDropDate: "2026-08-10", seasonEndDate: "2026-09-07",
    recentWeeks: 4, targetRemainingPct: 10, firstDropUplift: 2, secondDropUplift: 3
  });
  assert.equal(forecast.weeklyRunRate, 1);
  assert.equal(forecast.targetEndStock, 4);
  assert.ok(forecast.firstDropProjectedEndStock < forecast.secondDropProjectedEndStock);
  assert.ok(forecast.secondDropProjectedEndStock < forecast.fullPriceProjectedEndStock);
});

test("strong GA CVR protects price while low GA CVR increases candidate urgency", () => {
  const strong = reviewRecommendation(product({ stock: 12, units: 2, coverWks: 9, gaViews: 100, gaPurchases: 6 }), {
    asOf: "2026-07-20T12:00:00Z"
  });
  const weak = reviewRecommendation(product({ stock: 12, units: 2, coverWks: 9, gaViews: 100, gaPurchases: 0 }), {
    asOf: "2026-07-20T12:00:00Z"
  });
  assert.ok(strong.candidateScore < weak.candidateScore);
  assert.ok(strong.reasons.some(reason => /Strong GA CVR/.test(reason)));
  assert.ok(weak.reasons.some(reason => /Low GA CVR/.test(reason)));
});

test("summaries use weighted GA CVR, additive stock retail, and drop statistics", () => {
  const items = [
    { decision: "first_drop", stock: 10, stockRetailValue: 500, fullGaViews: 100, fullGaPurchases: 2, protectedRecentLaunch: false, metrics: { discountPercent: 20 } },
    { decision: "first_drop", stock: 15, stockRetailValue: 1500, fullGaViews: 0, fullGaPurchases: 0, protectedRecentLaunch: false, metrics: { discountPercent: 40 } },
    { decision: "second_drop", stock: 5, stockRetailValue: 300, fullGaViews: 20, fullGaPurchases: 2, protectedRecentLaunch: true, metrics: { discountPercent: 30 } },
    { decision: "hold", stock: 20, stockRetailValue: 400, fullGaViews: 80, fullGaPurchases: 0, protectedRecentLaunch: false, metrics: { discountPercent: 10 } }
  ];
  const summary = reviewSummary(items);
  assert.equal(summary.firstDrop, 2);
  assert.equal(summary.secondDrop, 1);
  assert.equal(summary.stockUnits, 50);
  assert.equal(summary.stockRetailValue, 2700);
  assert.equal(summary.gaCvr, 4 / 200);
  assert.deepEqual(summary.firstDropStats, {
    products: 2,
    stockUnits: 25,
    stockRetailValue: 2000,
    markdownInvestment: 700,
    avgDiscountPercent: 35
  });
  assert.deepEqual(summary.secondDropStats, {
    products: 1,
    stockUnits: 5,
    stockRetailValue: 300,
    markdownInvestment: 90,
    avgDiscountPercent: 30
  });
  assert.deepEqual(summary.notInDropStats, {
    products: 1,
    stockUnits: 20,
    stockRetailValue: 400,
    markdownInvestment: 40,
    avgDiscountPercent: 10
  });
  assert.equal(stockRetailValue(product({ variants: [
    { price: 50, inventoryQuantity: 2 },
    { price: 60, compareAtPrice: 80, inventoryQuantity: 3 }
  ] })), 340);
  assert.equal(normalizeDecision("SECOND_DROP"), "second_drop");
});
