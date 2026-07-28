"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPnl,
  buildScenario,
  breakEvenMarketingReturn,
  calculateCostRule,
  effectiveMarketingEntries,
  marketingForecastModel,
  marketingEntryAmount,
  normalizeActuals,
  operatingLeverage,
  shopifyQlSalesActualsFromRow,
  shopifyQlSalesActualsFromRows,
  sensitivityTables,
  validateRange
} = require("../lib/pnl");

const range = { startDate: "2026-06-15", endDate: "2026-07-14" };

test("accepts inclusive P&L ranges up to 366 days", () => {
  assert.deepEqual(validateRange({ startDate: "2024-01-01", endDate: "2024-12-31" }), {
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    days: 366
  });
  assert.throws(
    () => validateRange({ startDate: "2024-01-01", endDate: "2025-01-01" }),
    /366 days or less/i
  );
});

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

test("calculates reversed-item costs from Shopify reversal quantity", () => {
  const line = calculateCostRule({
    name: "Return handling",
    category: "Fulfilment",
    costType: "per_reversed_item",
    amount: 0.2,
    status: "Active"
  }, { range, netRevenue: 10000, orders: 100, units: 260, returnedUnits: 42 }, range);

  assert.equal(line.amountApplied, 8.4);
  assert.equal(line.formula, "0.2 per reversed item");
});

test("calculates blended card fees from order demand plus per order fee", () => {
  const line = calculateCostRule({
    name: "Card fees",
    category: "Payment",
    costType: "percent_revenue_plus_per_order",
    rate: 0.015,
    amount: 0.2,
    status: "Active"
  }, { range, netRevenue: 10000, orders: 250, units: 500 }, range);

  assert.equal(line.amountApplied, 200);
  assert.equal(line.formula, "1.5% of order demand + 0.2 per order");
});

test("revenue-based rules can use order intake including new shipping", () => {
  const line = calculateCostRule({
    name: "Card charges",
    category: "Payment",
    costType: "percent_revenue_plus_per_order",
    revenueBasis: "order_intake",
    rate: 0.02,
    amount: 0.2,
    status: "Active"
  }, {
    range: { startDate: "2026-07-01", endDate: "2026-07-01" },
    demandRevenue: 1000,
    newShippingRevenue: 100,
    despatchRevenue: 900,
    netRevenue: 750,
    orders: 10
  }, { startDate: "2026-07-01", endDate: "2026-07-01" });

  assert.equal(line.revenueBasis, "order_intake");
  assert.equal(line.revenueDrivenAmount, 22);
  assert.equal(line.orderDrivenAmount, 2);
  assert.equal(line.amountApplied, 24);
  assert.match(line.formula, /order intake/);
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

test("automated marketing spend overrides overlapping manual entries for the same channel", () => {
  const entries = effectiveMarketingEntries([
    { channel: "Google", startDate: "2026-06-01", endDate: "2026-06-07", amount: 1000, source: "manual" },
    { channel: "Meta", startDate: "2026-06-01", endDate: "2026-06-07", amount: 500, source: "manual" },
    { channel: "Google", startDate: "2026-06-03", endDate: "2026-06-03", amount: 120, source: "windsor", automated: true },
    { channel: "Affiliate", startDate: "2026-06-01", endDate: "2026-06-07", amount: 300, source: "manual" }
  ]);

  assert.deepEqual(entries.map(entry => `${entry.channel}:${entry.amount}`), [
    "Meta:500",
    "Google:120",
    "Affiliate:300"
  ]);

  const pnl = buildPnl({
    range: { startDate: "2026-06-01", endDate: "2026-06-07" },
    netRevenue: 10000,
    orders: 100,
    units: 200,
    cogs: 4000
  }, [], entries);
  assert.equal(pnl.marketingSpend, 920);
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

  assert.equal(pnl.productGrossProfit, 12800);
  assert.equal(pnl.grossProfit, 13450);
  assert.equal(pnl.grossRevenue, 24000);
  assert.equal(pnl.discounts, 1500);
  assert.equal(pnl.returns, 2500);
  assert.equal(pnl.shippingRevenue, 650);
  assert.equal(pnl.tax, 350);
  assert.equal(pnl.returnFees, 25);
  assert.equal(pnl.despatchRevenue, 21000);
  assert.equal(pnl.costRuleTotal, 1657.62);
  assert.equal(pnl.fixedCostTotal, 0);
  assert.equal(pnl.variableCostTotal, 1657.62);
  assert.equal(pnl.variableCostPerOrder, 4.14);
  assert.equal(pnl.orderVariableCostTotal, 1200);
  assert.equal(pnl.orderVariableCostPerOrder, 3);
  assert.equal(pnl.revenueVariableCostTotal, 457.62);
  assert.equal(pnl.marketingSpend, 2500);
  assert.equal(pnl.operatingRevenue, 20650);
  assert.equal(pnl.operatingProfit, 9292.38);
  assert.equal(pnl.grossProfitPerOrder, 33.63);
  assert.equal(pnl.operatingProfitPerOrder, 23.23);
  assert.equal(pnl.aov, 52.5);
  assert.ok(pnl.warnings.some(message => message.includes("missing Shopify unit cost")));
  assert.ok(pnl.warnings.some(message => message.includes("no COGS estimate")));
});

test("marks profit provisional when Windsor marketing coverage is incomplete", () => {
  const statement = buildPnl({
    range,
    netRevenue: 1000,
    grossRevenue: 1200,
    despatchRevenue: 1200,
    demandRevenue: 1200,
    grossProfit: 700,
    grossMarginRevenue: 1000,
    costedNetSales: 1000,
    orders: 10,
    marketingSpendProvisional: true,
    marketingQualityReasons: ["Google Windsor marketing spend has 1 day synced before finalisation."],
    marketingDataQuality: { applicable: true, complete: false }
  }, [], [{ id: "marketing", channel: "Google", startDate: range.startDate, endDate: range.endDate, amount: 200 }]);

  assert.equal(statement.marketingSpend, 200);
  assert.equal(statement.marketingSpendProvisional, true);
  assert.equal(statement.profitProvisional, true);
  assert.deepEqual(statement.marketingQualityReasons, ["Google Windsor marketing spend has 1 day synced before finalisation."]);
  assert.ok(statement.profitQualityReasons.includes("Google Windsor marketing spend has 1 day synced before finalisation."));
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
  assert.equal(actuals.grossUnits, 917);
  assert.equal(actuals.returnedUnits, 238);
  assert.equal(actuals.grossProfit, 17667.89);

  const statement = buildPnl(actuals);
  assert.equal(statement.cogs, 2362.02);
  assert.equal(statement.productGrossProfit, 17667.89);
  assert.equal(statement.grossProfit, 18377.96);
  assert.equal(statement.grossMarginRevenue, 17667.89 + 2362.02);
  assert.equal(statement.grossMargin, 17667.89 / (17667.89 + 2362.02));
  assert.equal(statement.operatingRevenue, 22176.46);
  assert.equal(statement.operatingProfit, 18377.96);
});

test("preserves signed 17 July Shopify reversals and separates sale adjustments", () => {
  const totals = {
    total_sales__totals: "4508.1",
    gross_sales__totals: "3997.23",
    net_sales__totals: "4246.26",
    discounts__totals: "-210.48",
    taxes__totals: "169.33",
    shipping_charges__totals: "92.51",
    return_fees__totals: "0",
    orders__totals: "71",
    gross_profit__totals: "594.53",
    cost_of_goods_sold__totals: "175.01",
    quantity_ordered__totals: "126",
    reversed_quantity__totals: "-92",
    net_sales_with_cost_recorded__totals: "769.54",
    net_sales_without_cost_recorded__totals: "-15.08"
  };
  const actuals = shopifyQlSalesActualsFromRows([
    { ...totals, order_or_sales_reversal: "order", is_sale_adjustment: false, line_type: "product", total_sales: "4544.1", net_sales: "3786.75" },
    { order_or_sales_reversal: "order", is_sale_adjustment: false, line_type: "shipping", total_sales: "120", net_sales: "0" },
    { order_or_sales_reversal: "reversal", is_sale_adjustment: false, line_type: "product", total_sales: "-3638.8", net_sales: "-3032.29" },
    { order_or_sales_reversal: "reversal", is_sale_adjustment: false, line_type: "shipping", total_sales: "-9", net_sales: "0" },
    { order_or_sales_reversal: "reversal", is_sale_adjustment: true, line_type: "sale_adjustment", total_sales: "3491.8", net_sales: "3491.8" }
  ], { startDate: "2026-07-17", endDate: "2026-07-17" });

  assert.equal(actuals.demandRevenue, 4544.1);
  assert.equal(Math.round(actuals.aov * 100) / 100, 64);
  assert.equal(actuals.productReversalRevenue, -3638.8);
  assert.equal(Math.round(actuals.productReversalRate * 1000) / 10, 80.1);
  assert.equal(actuals.productReversalNetRevenue, -3032.29);
  assert.equal(actuals.saleAdjustments, 3491.8);
  assert.equal(actuals.newShippingRevenue, 120);
  assert.equal(actuals.shippingReversalRevenue, -9);
  assert.equal(actuals.otherSalesRevenue, 0);
  assert.equal(actuals.despatchRevenue, 4508.1);
  assert.equal(actuals.returnedUnits, 92);
  assert.equal(actuals.profitProvisional, true);
  assert.ok(actuals.profitQualityReasons.some(message => message.includes("sale adjustments")));

  const scenario = buildScenario(actuals, [], [], { targetDailyDemand: actuals.demandRevenue });
  assert.equal(Math.round(scenario.scenario.orders), 71);
  assert.equal(Math.round(scenario.scenario.aov * 100) / 100, 64);
  assert.equal(scenario.delta.operatingProfit, 0);
});

test("reconciles the signed 26 July bridge and marks profit provisional", () => {
  const totals = {
    total_sales__totals: "4203.8",
    gross_sales__totals: "3714.63",
    net_sales__totals: "3983.04",
    discounts__totals: "-250.81",
    taxes__totals: "103.25",
    shipping_charges__totals: "117.51",
    return_fees__totals: "0",
    orders__totals: "81",
    gross_profit__totals: "437.46",
    cost_of_goods_sold__totals: "86.54",
    quantity_ordered__totals: "156",
    reversed_quantity__totals: "-102",
    net_sales_with_cost_recorded__totals: "524",
    net_sales_without_cost_recorded__totals: "-125.16"
  };
  const actuals = shopifyQlSalesActualsFromRows([
    { ...totals, order_or_sales_reversal: "order", is_sale_adjustment: false, line_type: "product", total_sales: "4156.6", net_sales: "3463.82" },
    { order_or_sales_reversal: "order", is_sale_adjustment: false, line_type: "shipping", total_sales: "152", net_sales: "0" },
    { order_or_sales_reversal: "reversal", is_sale_adjustment: false, line_type: "product", total_sales: "-3678", net_sales: "-3064.98" },
    { order_or_sales_reversal: "reversal", is_sale_adjustment: false, line_type: "shipping", total_sales: "-11", net_sales: "0" },
    { order_or_sales_reversal: "reversal", is_sale_adjustment: true, line_type: "sale_adjustment", total_sales: "3584.2", net_sales: "3584.2" }
  ], { startDate: "2026-07-26", endDate: "2026-07-26" });

  assert.equal(actuals.demandRevenue, 4156.6);
  assert.equal(actuals.productReversalRevenue, -3678);
  assert.equal(actuals.saleAdjustments, 3584.2);
  assert.equal(actuals.despatchRevenue, 4203.8);
  assert.ok(Math.abs(actuals.costCoverage - (524 / (524 + 125.16))) < 1e-12);
  assert.equal(actuals.profitProvisional, true);
  assert.equal(actuals.demandRevenue + actuals.newShippingRevenue + actuals.productReversalRevenue + actuals.shippingReversalRevenue + actuals.saleAdjustments + actuals.otherSalesRevenue, actuals.despatchRevenue);

  const audited = normalizeActuals({
    ...actuals,
    refundAuditAvailable: true,
    refundAuditStatus: "available",
    pendingRefundAmount: 3584.2,
    pendingRefundCount: 51,
    successfulRefundAmount: 112.4,
    successfulRefundCount: 2,
    refundTransactionCount: 53,
    refundRecordCount: 53,
    matchedPendingRefundAdjustment: undefined,
    residualSaleAdjustments: undefined,
    accruedSalesRevenue: undefined,
    accruedNetRevenue: undefined
  });
  assert.equal(audited.matchedPendingRefundAdjustment, 3584.2);
  assert.equal(audited.residualSaleAdjustments, 0);
  assert.equal(audited.accruedSalesRevenue, 619.6);
  assert.equal(audited.accruedNetRevenue, 398.84);
  assert.equal(audited.pendingRefundCount, 51);
  assert.ok(audited.refundSettlementNote.includes("do not add"));
  assert.ok(!audited.profitQualityReasons.some(message => message.includes("sale adjustments")));
});

test("treats matched pending refund settlement as informational rather than an extra deduction", () => {
  const actuals = normalizeActuals({
    range: { startDate: "2026-07-26", endDate: "2026-07-26" },
    netRevenue: 400,
    grossRevenue: 500,
    despatchRevenue: 4200,
    demandRevenue: 4300,
    saleAdjustments: 3500,
    refundAuditAvailable: true,
    pendingRefundAmount: 3500,
    pendingRefundCount: 50,
    grossProfit: 300,
    costedNetSales: 400,
    grossMarginRevenue: 400,
    orders: 80
  });

  assert.equal(actuals.matchedPendingRefundAdjustment, 3500);
  assert.equal(actuals.residualSaleAdjustments, 0);
  assert.equal(actuals.profitProvisional, false);
  assert.deepEqual(actuals.profitQualityReasons, []);
  assert.ok(actuals.refundSettlementNote.includes("already represented"));
  assert.ok(actuals.refundSettlementNote.includes("do not add"));
});

test("an unchanged refund-heavy scenario preserves the complete operating P&L", () => {
  const actual = buildPnl(normalizeActuals({
    range: { startDate: "2026-07-17", endDate: "2026-07-17" },
    despatchRevenue: 4508.1,
    demandRevenue: 4544.1,
    aovBasisRevenue: 4544.1,
    grossRevenue: 3997.23,
    netRevenue: 4246.26,
    accruedNetRevenue: 754.46,
    accruedSalesRevenue: 1016.3,
    productReversalRevenue: -3638.8,
    productReversalNetRevenue: -3032.29,
    shippingReversalRevenue: -9,
    saleAdjustments: 3491.8,
    matchedPendingRefundAdjustment: 3491.8,
    newShippingRevenue: 120,
    shippingRevenue: 92.51,
    discounts: 210.48,
    orders: 71,
    units: 126,
    returnedUnits: 92,
    cogs: 175.01,
    productGrossProfit: 594.53,
    costedNetSales: 769.54,
    grossMarginRevenue: 769.54,
    uncostedNetSales: -15.08
  }), [], []);
  const result = buildScenario(actual, [], [], {
    targetDailyDemand: actual.demandRevenue,
    itemsPerOrder: actual.itemsPerOrder
  });

  for (const key of [
    "demandRevenue", "despatchRevenue", "accruedNetRevenue", "operatingRevenue",
    "shippingRevenue", "productGrossProfit", "grossProfit", "grossMargin",
    "orders", "units", "operatingProfit", "operatingMargin"
  ]) {
    assert.equal(result.scenario[key], result.actual[key], key);
  }
  assert.deepEqual(result.scenario.reconciliation, {
    revenueDifference: 0,
    grossProfitDifference: 0,
    netProfitDifference: 0,
    passed: true
  });
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

test("marketing-driven scenarios change order demand and variable costs while fixed costs stay fixed", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    demandRevenue: 112000,
    aovBasisRevenue: 112000,
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

  assert.equal(result.scenario.demandRevenue, 120000);
  assert.equal(result.scenario.despatchRevenue, 107142.86);
  assert.equal(result.scenario.netRevenue, 85714.29);
  assert.equal(result.scenario.discounts, 3214.29);
  assert.equal(result.scenario.returns, 6428.57);
  assert.equal(result.scenario.shippingRevenue, 2678.57);
  assert.equal(result.scenario.marketingSpend, 12000);
  assert.equal(Math.round(result.scenario.orders * 100) / 100, 2142.86);
  assert.equal(result.scenario.costLines.find(line => line.name === "Rent").amountApplied, 6000);
  assert.equal(result.scenario.costLines.find(line => line.name === "Payment fees").amountApplied, 2400);
  assert.equal(result.scenario.costLines.find(line => line.name === "Customer service").amountApplied, 2142.86);
  assert.equal(result.scenario.variableCostTotal, 4542.86);
  assert.equal(result.scenario.variableCostPerOrder, 2.12);
  assert.equal(result.scenario.orderVariableCostTotal, 2142.86);
  assert.equal(result.scenario.orderVariableCostPerOrder, 1);
  assert.equal(result.scenario.revenueVariableCostTotal, 2400);
  assert.equal(result.delta.variableCostPerOrder, 0);
});

test("channel attribution splits forecast returns without changing blended Shopify return", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-07" },
    despatchRevenue: 70000,
    netRevenue: 56000,
    orders: 1400,
    units: 2800,
    cogs: 28000
  });
  const marketing = [
    { channel: "Google", startDate: "2026-06-01", endDate: "2026-06-07", amount: 3000, data: { attributedRevenue: 9000, attributionWeight: 1 } },
    { channel: "Meta", startDate: "2026-06-01", endDate: "2026-06-07", amount: 2000, data: { attributedRevenue: 16000, attributionWeight: 0.5 } }
  ];
  const base = buildScenario(actual, [], marketing, {
    marketingDrivesSales: true,
    marketingReturn: 4
  });
  const model = marketingForecastModel(base.actual, { marketingReturn: 4 });

  assert.equal(model.blendedReturn, 4);
  assert.equal(model.channels.find(channel => channel.channel === "Google").calibratedReturn, 3.53);
  assert.equal(model.channels.find(channel => channel.channel === "Meta").calibratedReturn, 4.71);

  const result = buildScenario(actual, [], marketing, {
    targetDailySales: 10000,
    marketingDrivesSales: true,
    marketingReturn: 4,
    channelMarketingSpend: {
      Google: 4000,
      Meta: 2000
    }
  });

  assert.equal(result.marketingForecast.scenarioSpend, 6000);
  assert.equal(result.marketingForecast.incrementalRevenue, 3529.41);
  assert.equal(result.scenario.despatchRevenue, 73529.41);

  const override = buildScenario(actual, [], marketing, {
    targetDailySales: 10000,
    marketingDrivesSales: true,
    marketingReturn: 4,
    channelMarketingSpend: {
      Google: 4000,
      Meta: 2000
    },
    channelMarketingReturn: {
      Google: 6,
      Meta: 2
    }
  });

  assert.equal(override.marketingForecast.incrementalRevenue, 6000);
  assert.equal(override.marketingForecast.channels.find(channel => channel.channel === "Google").scenarioReturn, 6);
  assert.equal(override.scenario.despatchRevenue, 76000);
});

test("channel attribution caps extreme platform scores before calibration", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-07" },
    despatchRevenue: 70000,
    netRevenue: 56000,
    orders: 1400,
    units: 2800,
    cogs: 28000
  });
  const marketing = [
    { channel: "Google", startDate: "2026-06-01", endDate: "2026-06-07", amount: 100, data: { attributedRevenue: 10000, attributionWeight: 1 } },
    { channel: "Meta", startDate: "2026-06-01", endDate: "2026-06-07", amount: 100, data: { attributedRevenue: 100, attributionWeight: 1 } }
  ];
  const base = buildScenario(actual, [], marketing, {
    marketingDrivesSales: true,
    marketingReturn: 5
  });
  const google = base.marketingForecast.channels.find(channel => channel.channel === "Google");

  assert.equal(google.uncappedRawScore, 100);
  assert.equal(google.rawScore, 7.5);
  assert.equal(google.scoreCapped, true);
  assert.equal(base.marketingForecast.blendedReturn, 5);
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

test("calculates incremental break-even marketing ROAS from the cost stack", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    netRevenue: 80000,
    orders: 2000,
    units: 4000,
    cogs: 40000
  });
  const rules = [
    { name: "Rent", category: "Overheads", costType: "fixed_monthly", amount: 6000, status: "Active" },
    { name: "Card fees", category: "Payment", costType: "percent_revenue_plus_per_order", rate: 0.02, amount: 0.2, status: "Active" },
    { name: "Postage", category: "Postage", costType: "per_order", amount: 3, status: "Active" },
    { name: "Pack materials", category: "Fulfilment", costType: "per_item", amount: 0.5, status: "Active" }
  ];
  const result = breakEvenMarketingReturn(actual, rules, {
    targetDailySales: 100000 / 30,
    aovDelta: 0,
    itemsPerOrder: 2
  });

  assert.equal(result.contributionMargin, 0.296);
  assert.equal(result.requiredReturn, 3.38);
});

test("operating leverage identifies breakeven and fixed-cost dilution points", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    netRevenue: 80000,
    orders: 2000,
    units: 4000,
    cogs: 40000
  });
  const rules = [
    { name: "Rent", category: "Overheads", costType: "fixed_monthly", amount: 6000, status: "Active" },
    { name: "Postage", category: "Postage", costType: "per_order", amount: 2, status: "Active" }
  ];
  const result = operatingLeverage(actual, rules, [], {
    targetDailySales: 100000 / 30
  });

  assert.equal(result.selected.fixedCostTotal, 6000);
  assert.equal(result.selected.fixedCostPerOrder, 3);
  assert.equal(result.selected.fixedCostImpact, 0.075);
  assert.equal(result.selected.contributionMargin, 0.45);
  assert.ok(Math.abs(result.breakEven.dailyDespatch - 555.56) < 0.01);
  assert.ok(Math.abs(result.lowFixedDrag.dailyDespatch - 5000) < 0.01);
  assert.equal(result.lowFixedDrag.fixedCostImpact, 0.05);
  assert.ok(result.points.some(point => point.dailyDespatch === result.lowFixedDrag.dailyDespatch));
});

test("linked daily despatch target does not double-count marketing uplift", () => {
  const actual = normalizeActuals({
    range: { startDate: "2026-06-01", endDate: "2026-06-30" },
    despatchRevenue: 100000,
    netRevenue: 80000,
    orders: 2000,
    units: 4000,
    cogs: 40000
  });
  const marketing = [
    { channel: "Google", startDate: "2026-06-01", endDate: "2026-06-30", amount: 10000, data: { attributedRevenue: 40000, attributionWeight: 1 } }
  ];
  const result = buildScenario(actual, [], marketing, {
    targetDailySales: 110000 / 30,
    targetDailySalesIncludesMarketing: true,
    marketingDrivesSales: true,
    marketingSpend: 12000,
    channelMarketingSpend: { Google: 12000 },
    channelMarketingReturn: { Google: 5 }
  });

  assert.equal(result.marketingForecast.incrementalRevenue, 10000);
  assert.equal(result.scenario.despatchRevenue, 110000);
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
