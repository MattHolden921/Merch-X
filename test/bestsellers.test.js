"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const bestsellers = require("../lib/bestsellers");

test("strict report dates reject impossible dates, reversed ranges, and excessive ranges", () => {
  assert.equal(bestsellers.validIsoDate("2024-02-29"), true);
  assert.equal(bestsellers.validIsoDate("2026-02-29"), false);
  assert.equal(bestsellers.validIsoDate("2026-02-31"), false);
  assert.throws(() => bestsellers.validateRange({ startDate: "2026-07-13", endDate: "" }), /real calendar dates/i);
  assert.throws(() => bestsellers.validateRange({ startDate: "2026-07-13", endDate: "2026-07-12" }), /end date/i);
  assert.throws(() => bestsellers.validateRange({ startDate: "2025-01-01", endDate: "2026-01-03" }, 367), /366 days/i);
});

test("canonical weeks and contiguous saved-week groups are explicit", () => {
  assert.equal(bestsellers.isCanonicalMondaySundayWeek({ startDate: "2026-07-06", endDate: "2026-07-12" }), true);
  assert.equal(bestsellers.isCanonicalMondaySundayWeek({ startDate: "2026-07-07", endDate: "2026-07-13" }), false);
  assert.deepEqual(bestsellers.contiguousWeekRanges([
    { id: "c", startDate: "2026-06-15", endDate: "2026-06-21" },
    { id: "b", startDate: "2026-06-29", endDate: "2026-07-05" },
    { id: "a", startDate: "2026-07-06", endDate: "2026-07-12" },
    { id: "old-noncanonical", startDate: "2026-05-01", endDate: "2026-05-31" }
  ]), [
    { startDate: "2026-06-29", endDate: "2026-07-12", weekCount: 2, periodIds: ["a", "b"] },
    { startDate: "2026-06-15", endDate: "2026-06-21", weekCount: 1, periodIds: ["c"] }
  ]);
});

test("order aggregation keeps genuine gross and discounted net values, prorates returns, and excludes gift cards", () => {
  const metrics = new Map();
  bestsellers.addOrderLineMetric(metrics, {
    quantity: 4,
    currentQuantity: 3,
    originalTotalSet: { shopMoney: { amount: "120.00" } },
    discountedTotalSet: { shopMoney: { amount: "90.00" } },
    product: { id: "p1" },
    variant: { id: "v1" }
  });
  bestsellers.addOrderLineMetric(metrics, {
    quantity: 1,
    currentQuantity: 1,
    isGiftCard: true,
    originalTotalSet: { shopMoney: { amount: "50.00" } },
    discountedTotalSet: { shopMoney: { amount: "50.00" } },
    product: { id: "gift" },
    variant: { id: "vg" }
  });
  assert.equal(metrics.has("gift"), false);
  assert.equal(metrics.get("p1").units, 3);
  assert.equal(metrics.get("p1").revenue, 67.5);
  assert.equal(metrics.get("p1").grossSales, 90);
  assert.equal(metrics.get("p1").discounts, 22.5);
  assert.equal(metrics.get("p1").returns, 22.5);
  assert.equal(metrics.get("p1").grossUnits, 4);
  assert.equal(metrics.get("p1").returnedUnits, 1);
  assert.equal(metrics.get("p1").salesIncludeVat, false);
  assert.equal(metrics.get("p1").variants.get("v1").units, 3);
});

test("full-price classification ignores discount codes and only treats compare-at markdowns as sale", () => {
  const result = bestsellers.calculateProductFinancials({
    source: "shopifyql_sales",
    salesIncludeVat: false,
    revenue: 160 / 1.2,
    grossSales: 170 / 1.2,
    discounts: 10 / 1.2,
    returns: 0,
    units: 3,
    grossUnits: 3,
    returnedUnits: 0,
    grossProfit: 80,
    costOfGoods: 160 / 1.2 - 80,
    variants: new Map([
      ["v1", { units: 2, grossUnits: 2, revenue: 100, grossSales: 120 / 1.2 }],
      ["v2", { units: 1, grossUnits: 1, revenue: 160 / 1.2 - 100, grossSales: 50 / 1.2 }]
    ])
  }, [
    { id: "v1", price: 60, compareAtPrice: null, cost: 20 },
    { id: "v2", price: 50, compareAtPrice: 90, cost: 25 }
  ]);
  assert.equal(result.fullPriceGrossUnits, 2);
  assert.equal(result.markdownGrossUnits, 1);
  assert.equal(result.rrpOpportunityIncVat, 210);
  assert.ok(Math.abs(result.markdownLeakageIncVat - 40) < 1e-9);
  assert.ok(Math.abs(result.discountsIncVat - 10) < 1e-9);
});

test("pre-discount selling price preserves historical markdown classification after a product returns to RRP", () => {
  const result = bestsellers.calculateProductFinancials({
    source: "shopifyql_sales",
    revenue: 40,
    grossSales: 40,
    units: 1,
    grossUnits: 1,
    grossProfit: 20,
    costOfGoods: 20,
    variants: new Map([["v1", { units: 1, grossUnits: 1, revenue: 40, grossSales: 40 }]])
  }, [{ id: "v1", price: 60, compareAtPrice: null, cost: 20 }]);
  assert.equal(result.markdownGrossUnits, 1);
  assert.equal(result.fullPriceGrossUnits, 0);
  assert.equal(result.rrpOpportunityIncVat, 60);
  assert.equal(result.markdownLeakageIncVat, 12);
});

test("ex-VAT GP is variant-sales-weighted when every sold unit has cost", () => {
  const metric = {
    revenue: 180,
    grossSales: 240,
    units: 3,
    variants: new Map([
      ["v1", { units: 2, revenue: 100, grossSales: 140 }],
      ["v2", { units: 1, revenue: 80, grossSales: 100 }]
    ])
  };
  const result = bestsellers.calculateProductFinancials(metric, [
    { id: "v1", cost: 20, price: 60, inventoryQuantity: 4 },
    { id: "v2", cost: 30, price: 90, inventoryQuantity: 1 }
  ]);
  assert.equal(result.revenueExVat, 150);
  assert.equal(result.revenueIncVat, 180);
  assert.equal(result.grossSalesIncVat, 240);
  assert.equal(result.costOfGoods, 70);
  assert.equal(result.grossProfit, 80);
  assert.equal(result.averageSoldUnitCost, 70 / 3);
  assert.equal(result.currentInventoryCost, 22);
  assert.equal(result.cost, 22);
  assert.equal(result.stockCostValue, 110);
  assert.equal(result.stockRetailValue, 330);
  assert.equal(result.stockCostCoveragePercent, 100);
  assert.equal(result.costCoveragePercent, 100);
  assert.equal(result.costQuality, "complete");
});

test("missing sold-variant cost preserves unknown GP and exposes partial coverage", () => {
  const result = bestsellers.calculateProductFinancials({
    revenue: 180,
    grossSales: 180,
    units: 3,
    variants: new Map([
      ["v1", { units: 2, revenue: 120 }],
      ["v2", { units: 1, revenue: 60 }]
    ])
  }, [
    { id: "v1", cost: 20 },
    { id: "v2", cost: null }
  ]);
  assert.equal(result.grossProfit, null);
  assert.equal(result.costOfGoods, null);
  assert.equal(result.knownGrossProfit, 60);
  assert.equal(result.costedUnits, 2);
  assert.equal(result.uncostedUnits, 1);
  assert.ok(Math.abs(result.costCoveragePercent - 200 / 3) < 1e-9);
  assert.equal(result.costQuality, "partial");
});

test("ShopifyQL product metrics preserve dated ex-VAT sales, reversals, COGS, and GP", () => {
  const result = bestsellers.calculateProductFinancials({
    source: "shopifyql_sales",
    salesIncludeVat: false,
    revenue: 80,
    grossSales: 150,
    grossProfit: 50,
    costOfGoods: 30,
    units: -1,
    variants: new Map()
  }, []);
  assert.equal(result.revenue, 80);
  assert.equal(result.revenueExVat, 80);
  assert.equal(result.revenueIncVat, 96);
  assert.equal(result.grossSalesExVat, 150);
  assert.equal(result.units, -1);
  assert.equal(result.costOfGoods, 30);
  assert.equal(result.grossProfit, 50);
  assert.equal(result.costQuality, "shopify_reported");
});

test("saved ex-VAT periods expose VAT-inclusive display values without changing canonical values", () => {
  assert.deepEqual(
    bestsellers.storedSalesFinancials(
      { net_sales: 100, gross_sales: 150 },
      {},
      { salesValuesIncludeVat: true }
    ),
    {
      netSalesExVat: 100,
      grossSalesExVat: 150,
      netSalesIncVat: 120,
      grossSalesIncVat: 180,
      storedSalesIncludeVat: false,
      vatRate: 0.2
    }
  );
  const explicit = bestsellers.storedSalesFinancials(
    { net_sales: 999, gross_sales: 999 },
    { revenueExVat: 80, grossSalesExVat: 120 },
    { salesValuesIncludeVat: false }
  );
  assert.equal(explicit.netSalesExVat, 80);
  assert.equal(explicit.netSalesIncVat, 96);
  assert.equal(explicit.grossSalesIncVat, 144);
  const explicitlyVatStored = bestsellers.storedSalesFinancials(
    { net_sales: 120, gross_sales: 180 },
    {},
    { storedSalesValuesIncludeVat: true }
  );
  assert.equal(explicitlyVatStored.netSalesExVat, 100);
  assert.equal(explicitlyVatStored.netSalesIncVat, 120);
});

test("Demand and Despatch combine only when every selected Bestsellers period has P&L-aligned metrics", () => {
  const combined = bestsellers.combineTradingMetrics([
    { label: "29 Jun", summary: { tradingMetrics: { demandRevenue: 108, despatchRevenue: 102, grossRevenue: 100, discounts: 10, returns: 5, netRevenue: 80, shippingRevenue: 5, tax: 17, returnFees: 0, grossUnits: 20, returnedUnits: 2, netUnits: 18 } } },
    { label: "6 Jul", summary: { tradingMetrics: { demandRevenue: 216, despatchRevenue: 204, grossRevenue: 200, discounts: 20, returns: 10, netRevenue: 160, shippingRevenue: 10, tax: 34, returnFees: 0, grossUnits: 40, returnedUnits: 4, netUnits: 36 } } }
  ]);
  assert.equal(combined.available, true);
  assert.equal(combined.demandRevenue, 324);
  assert.equal(combined.despatchRevenue, 306);
  assert.equal(combined.periods["29 Jun"].demandRevenue, 108);
  assert.equal(combined.selections.last1.demandRevenue, 216);
  assert.equal(combined.selections.last1.despatchRevenue, 204);
  assert.equal(combined.returns, 15);
  assert.equal(combined.grossUnits, 60);
  assert.equal(combined.returnedUnits, 6);
  assert.equal(combined.version, bestsellers.TRADE_METRICS_VERSION);

  const incomplete = bestsellers.combineTradingMetrics([
    { label: "29 Jun", summary: { tradingMetrics: { demandRevenue: 108, despatchRevenue: 102, grossRevenue: 100, discounts: 10, returns: 5, netRevenue: 80, shippingRevenue: 5, tax: 17, returnFees: 0, grossUnits: 20, returnedUnits: 2, netUnits: 18 } } },
    { label: "6 Jul", summary: {} }
  ]);
  assert.equal(incomplete.available, false);
  assert.equal(incomplete.demandRevenue, null);
  assert.equal(incomplete.despatchRevenue, null);
});

test("legacy saved zero GP stays unknown when the sold product had no cost", () => {
  assert.equal(bestsellers.storedGrossProfit({ gross_profit: 0, cost: null }, {}, 5), null);
  assert.equal(bestsellers.storedGrossProfit({ gross_profit: 0, cost: 10 }, {}, 5), 0);
  assert.equal(bestsellers.storedGrossProfit(
    { gross_profit: 0, cost: null },
    { costQuality: "complete", costedUnits: 5 },
    5
  ), 0);
  assert.equal(bestsellers.storedGrossProfit(
    { gross_profit: 80, cost: 20 },
    {},
    1,
    { salesIncludeVat: true, revenue: 120, revenueExVat: 100, revenueBasis: "" }
  ), 60);
});

test("decision ROS, cover, and forecast use the supplied latest period only", () => {
  assert.deepEqual(bestsellers.decisionRateMetrics({ units: 14, rev: 700 }, 20, 7, 8), {
    decisionUnits: 14,
    decisionRevenue: 700,
    wklyU: 14,
    avgRevPerWeek: 700,
    coverWks: 20 / 14,
    forecastBuy: 92
  });
});

test("Weekly Actions are limited to active, non-gift-card Shopify products", () => {
  assert.equal(bestsellers.weeklyActionEligible({ status: "ACTIVE", title: "Dress" }), true);
  assert.equal(bestsellers.weeklyActionEligible({ status: "DRAFT", title: "Dress" }), false);
  assert.equal(bestsellers.weeklyActionEligible({ status: "ARCHIVED", title: "Dress" }), false);
  assert.equal(bestsellers.weeklyActionEligible({ status: "ACTIVE", isGiftCard: true, title: "Gift Card" }), false);
});

test("incomplete Shopify order line connections fail closed", () => {
  assert.throws(
    () => bestsellers.assertCompleteOrderLineConnection({ nodes: [], pageInfo: { hasNextPage: true } }),
    /stopped to avoid saving incomplete sales metrics/i
  );
  assert.throws(() => bestsellers.assertCompleteOrderLineConnection(null), /protect the saved report/i);
});

test("stale sync jobs are detected and startup recovery interrupts and bounds retained payloads", () => {
  assert.equal(bestsellers.isStaleSyncJob({ status: "running", updated_at: "2026-07-13T08:00:00.000Z" }, Date.parse("2026-07-13T11:00:00.000Z")), true);
  assert.equal(bestsellers.isStaleSyncJob({ status: "complete", updated_at: "2026-07-13T08:00:00.000Z" }, Date.parse("2026-07-13T11:00:00.000Z")), false);

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE report_sync_jobs (
      id TEXT PRIMARY KEY, report_type TEXT, status TEXT, message TEXT, error TEXT,
      result_json TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT
    );
    INSERT INTO report_sync_jobs VALUES
      ('running', 'bestsellers', 'running', '', '', '{"large":true}', datetime('now', '-1 hour'), datetime('now', '-1 hour'), NULL),
      ('recent', 'bestsellers', 'complete', '', '', '{"keep":true}', datetime('now', '-1 day'), datetime('now', '-1 day'), datetime('now', '-1 day')),
      ('old', 'bestsellers', 'complete', '', '', '{"clear":true}', datetime('now', '-20 days'), datetime('now', '-20 days'), datetime('now', '-20 days')),
      ('expired', 'bestsellers', 'error', '', '', '{"delete":true}', datetime('now', '-100 days'), datetime('now', '-100 days'), datetime('now', '-100 days')),
      ('other', 'other_report', 'running', '', '', '{"untouched":true}', datetime('now', '-100 days'), datetime('now', '-100 days'), NULL);
  `);
  const result = bestsellers.recoverReportSyncJobs(db);
  assert.deepEqual(result, { interrupted: 1, payloadsCleared: 2, jobsDeleted: 1 });
  assert.match(db.prepare("SELECT error FROM report_sync_jobs WHERE id = 'running'").get().error, /server restart/i);
  assert.equal(db.prepare("SELECT result_json FROM report_sync_jobs WHERE id = 'old'").get().result_json, null);
  assert.equal(db.prepare("SELECT id FROM report_sync_jobs WHERE id = 'expired'").get(), undefined);
  assert.equal(db.prepare("SELECT status FROM report_sync_jobs WHERE id = 'other'").get().status, "running");
  db.close();
});
