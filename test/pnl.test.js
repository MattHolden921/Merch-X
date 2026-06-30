"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPnl,
  buildScenario,
  calculateCostRule,
  marketingEntryAmount,
  normalizeActuals,
  shopifyQlSalesActualsFromRow,
  sensitivityTables
} = require("../lib/pnl");

const range = { startDate: "2026-06-15", endDate: "2026-07-14" };

test("prorates fixed monthly cost across partial calendar months", () => {
  const line = calculateCostRule({
    name: "Rent",
    category: "Overheads",
    costType: "fixed_monthly",
    amount: 3100,
    status: "Active"
  }, { range, netRevenue: 10000, orders: 100, units: 200 }, range);

  assert.equal(line.overlapDays, 30);
  assert.equal(line.amountApplied, 3053.33);
});

test("calculates pick and pack first item plus additional item rate", () => {
  const line = calculateCostRule({
    name: "Pick and pack",
    category: "Fulfilment",
    costType: "pick_pack",
    firstItemRate: 1.2,
    additionalItemRate: 0.35,
    status: "Active"
  }, { range, netRevenue: 10000, orders: 100, units: 260 }, range);

  assert.equal(line.amountApplied, 176);
});

test("calculates blended card fees as revenue percent plus per order fee", () => {
  const line = calculateCostRule({
    name: "Card fees",
    category: "Payment",
    costType: "percent_revenue_plus_per_order",
    rate: 0.015,
    amount: 0.2,
    status: "Active"
  }, { range, netRevenue: 10000, orders: 250, units: 500 }, range);

  assert.equal(line.amountApplied, 200);
});

test("prorates marketing spend entries by date overlap", () => {
  const applied = marketingEntryAmount({
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    amount: 3000
  }, { startDate: "2026-06-15", endDate: "2026-06-30" });

  assert.equal(applied.overlapDays, 16);
  assert.equal(applied.amountApplied, 1600);
});

test("builds actual P&L totals and missing-cost warnings", () => {
  const pnl = buildPnl({
    range,
    netRevenue: 20000,
    grossRevenue: 24000,
    despatchRevenue: 21000,
    discounts: 1500,
    returns: 2500,
    shippingRevenue: 650,
    tax: 350,
    returnFees: 25,
    orders: 400,
    units: 760,
    cogs: 7200,
    missingCostUnits: 5,
    missingCostRevenue: 120
  }, [
    { name: "Payment fees", category: "Payment", costType: "percent_revenue", rate: 0.02, status: "Active" },
    { name: "Postage", category: "Postage", costType: "per_order", amount: 3, status: "Active" }
  ], [
    { channel: "Google", startDate: "2026-06-15", endDate: "2026-07-14", amount: 2500 }
  ]);

  assert.equal(pnl.grossProfit, 12800);
  assert.equal(pnl.grossRevenue, 24000);
  assert.equal(pnl.discounts, 1500);
  assert.equal(pnl.returns, 2500);
  assert.equal(pnl.shippingRevenue, 650);
  assert.equal(pnl.tax, 350);
  assert.equal(pnl.returnFees, 25);
  assert.equal(pnl.despatchRevenue, 21000);
  assert.equal(pnl.costRuleTotal, 1620);
  assert.equal(pnl.variableCostTotal, 1620);
  assert.equal(pnl.variableCostPerOrder, 4.05);
  assert.equal(pnl.orderVariableCostTotal, 1200);
  assert.equal(pnl.orderVariableCostPerOrder, 3);
  assert.equal(pnl.revenueVariableCostTotal, 420);
  assert.equal(pnl.marketingSpend, 2500);
  assert.equal(pnl.operatingProfit, 8680);
  assert.equal(pnl.aov, 52.5);
  assert.ok(pnl.warnings.some(message => message.includes("missing Shopify unit cost")));
  assert.ok(pnl.warnings.some(message => message.includes("no COGS estimate")));
});

test("maps ShopifyQL sales report rows to Despatch, Demand, and profit actuals", () => {
  const actuals = shopifyQlSalesActualsFromRow({
    total_sales: "26610.83",
    gross_sales: "28949.62",
    net_sales: "21466.39",
    discounts: "-1116.8",
    taxes: "4434.37",
    returns: "-6366.43",
    shipping_charges: "710.07",
    return_fees: "0",
    orders: "538",
    gross_profit: "17667.89",
    cost_of_goods_sold: "2362.02",
    quantity_ordered: "917",
    quantity_returned: "-238"
  }, { startDate: "2026-06-22", endDate: "2026-06-28" });

  assert.equal(actuals.despatchRevenue, 26610.83);
  assert.equal(actuals.demandRevenue, 33398.23);
  assert.equal(actuals.grossRevenue, 28949.62);
  assert.equal(actuals.netRevenue, 21466.39);
  assert.equal(actuals.discounts, 1116.8);
  assert.equal(actuals.returns, 6366.43);
  assert.equal(actuals.shippingRevenue, 710.07);
  assert.equal(actuals.tax, 4434.37);
  assert.equal(actuals.orders, 538);
  assert.equal(actuals.units, 917);
  assert.equal(actuals.grossProfit, 17667.89);
});

test("scenario scales sales, AOV, marketing, and variable costs while fixed costs stay fixed", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    netRevenue: 150000,
    orders: 3000,
    units: 6000,
    cogs: 60000
  });
  const result = buildScenario(actual, [
    { name: "Rent", category: "Overheads", costType: "fixed_monthly", amount: 6000, status: "Active" },
    { name: "Pick pack", category: "Fulfilment", costType: "pick_pack", firstItemRate: 1, additionalItemRate: 0.5, status: "Active" }
  ], [
    { channel: "Meta", startDate: "2026-06-01", endDate: "2026-06-30", amount: 12000 }
  ], {
    targetDailySales: 6000,
    aovDelta: 5,
    marketingSpend: 15000
  });

  assert.equal(result.actual.netRevenue, 150000);
  assert.equal(result.scenario.netRevenue, 180000);
  assert.equal(Math.round(result.scenario.orders), 3273);
  assert.equal(Math.round(result.scenario.units), 6545);
  assert.equal(result.scenario.costLines.find(line => line.name === "Rent").amountApplied, 6000);
  assert.equal(result.scenario.marketingSpend, 15000);
  assert.ok(result.scenario.operatingProfit > result.actual.operatingProfit);
});

test("marketing-driven scenarios change sales and variable costs while fixed costs stay fixed", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    demandRevenue: 112000,
    grossRevenue: 95000,
    netRevenue: 80000,
    discounts: 3000,
    returns: 6000,
    shippingRevenue: 2500,
    tax: 17500,
    orders: 2000,
    units: 4000,
    cogs: 40000
  });
  const result = buildScenario(actual, [
    { name: "Rent", category: "Overheads", costType: "fixed_monthly", amount: 6000, status: "Active" },
    { name: "Payment fees", category: "Payment", costType: "percent_revenue", rate: 0.02, status: "Active" },
    { name: "Customer service", category: "Overheads", costType: "per_order", amount: 1, status: "Active" }
  ], [
    { channel: "Google", startDate: "2026-06-01", endDate: "2026-06-30", amount: 10000 }
  ], {
    marketingSpend: 12000,
    marketingDrivesSales: true,
    marketingReturn: 4
  });

  assert.equal(result.scenario.despatchRevenue, 108000);
  assert.equal(result.scenario.netRevenue, 86400);
  assert.equal(result.scenario.discounts, 3240);
  assert.equal(result.scenario.returns, 6480);
  assert.equal(result.scenario.shippingRevenue, 2700);
  assert.equal(result.scenario.marketingSpend, 12000);
  assert.equal(result.scenario.orders, 2160);
  assert.equal(result.scenario.costLines.find(line => line.name === "Rent").amountApplied, 6000);
  assert.equal(result.scenario.costLines.find(line => line.name === "Payment fees").amountApplied, 2160);
  assert.equal(result.scenario.costLines.find(line => line.name === "Customer service").amountApplied, 2160);
  assert.equal(result.scenario.variableCostTotal, 4320);
  assert.equal(result.scenario.variableCostPerOrder, 2);
  assert.equal(result.scenario.orderVariableCostTotal, 2160);
  assert.equal(result.scenario.orderVariableCostPerOrder, 1);
  assert.equal(result.scenario.revenueVariableCostTotal, 2160);
  assert.equal(result.delta.variableCostPerOrder, 0);
});

test("higher AOV lowers total order-driven variable costs when despatch is unchanged", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    netRevenue: 80000,
    orders: 2000,
    units: 4000,
    cogs: 40000
  });
  const result = buildScenario(actual, [
    { name: "Rent", category: "Overheads", costType: "fixed_monthly", amount: 6000, status: "Active" },
    { name: "Card fees", category: "Payment", costType: "percent_revenue_plus_per_order", rate: 0.02, amount: 0.2, status: "Active" },
    { name: "Postage", category: "Postage", costType: "per_order", amount: 3, status: "Active" },
    { name: "Pack materials", category: "Fulfilment", costType: "per_item", amount: 0.5, status: "Active" }
  ], [], {
    targetDailySales: 100000 / 30,
    aovDelta: 10
  });

  assert.equal(result.actual.variableCostTotal, 10400);
  assert.equal(result.actual.orderVariableCostTotal, 8400);
  assert.ok(result.scenario.orders < result.actual.orders);
  assert.ok(result.scenario.variableCostTotal < result.actual.variableCostTotal);
  assert.ok(result.scenario.orderVariableCostTotal < result.actual.orderVariableCostTotal);
  assert.equal(result.scenario.revenueVariableCostTotal, result.actual.revenueVariableCostTotal);
});

test("daily despatch sensitivity still varies when marketing drives sales", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    netRevenue: 80000,
    orders: 2000,
    units: 4000,
    cogs: 40000
  });
  const tables = sensitivityTables(actual, [], [
    { channel: "Google", startDate: "2026-06-01", endDate: "2026-06-30", amount: 10000 }
  ], {
    marketingSpend: 12000,
    marketingDrivesSales: true,
    marketingReturn: 4
  });

  assert.deepEqual(tables.dailySales.map(row => row.despatchRevenue), [78000, 108000, 138000, 168000]);
  assert.deepEqual(tables.marketing.map(row => row.despatchRevenue), [104000, 108000, 112000, 118000]);
});
