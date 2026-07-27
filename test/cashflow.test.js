"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { addBusinessDays, buildCashflow, buildWeeks, mondayOf, monthlyPaymentDates, quarterlyVatPeriods, vatPaymentDate } = require("../lib/cashflow");

test("normalizes weeks to Monday and shifts receipts by business days", () => {
  assert.equal(mondayOf("2026-07-22"), "2026-07-20");
  assert.equal(addBusinessDays("2026-07-24", 3), "2026-07-29");
  assert.equal(addBusinessDays("2026-07-25", 3), "2026-07-29");
  assert.deepEqual(buildWeeks("2026-07-22", 2).map(week => [week.startDate, week.endDate]), [
    ["2026-07-20", "2026-07-26"],
    ["2026-07-27", "2026-08-02"]
  ]);
});

test("uses actual Despatch through yesterday then spreads the remaining weekly budget", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 3,
    asOfDate: "2026-07-22",
    openingBalance: 1000,
    receiptLagBusinessDays: 3,
    forecastAov: 50,
    forecastItemsPerOrder: 2,
    budgets: [{ weekStart: "2026-07-20", amount: 700 }, { weekStart: "2026-07-27", amount: 1400 }],
    dailyActuals: [
      { date: "2026-07-20", despatch: 120, orders: 2, units: 4 },
      { date: "2026-07-21", despatch: 80, orders: 2, units: 3 }
    ]
  });

  assert.equal(result.weeks[0].despatchActual, 200);
  assert.equal(result.weeks[0].despatchForecast, 500);
  assert.equal(result.weeks[0].despatchPlan, 700);
  assert.equal(result.weeks[1].despatchForecast, 1400);
  assert.equal(result.totals.receipts, 2100);
});

test("charges each combined weekly Meta and PPC budget in its forecast week", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 2,
    asOfDate: "2026-07-19",
    openingBalance: 5000,
    budgets: [
      { weekStart: "2026-07-20", amount: 7000, marketingAmount: 800 },
      { weekStart: "2026-07-27", amount: 7000, marketingAmount: 900 }
    ]
  });

  assert.equal(result.weeks[0].marketingBudget, 800);
  assert.equal(result.weeks[0].marketingSpend, 800);
  assert.equal(result.weeks[0].movements.find(row => row.name === "Meta + PPC budget").date, "2026-07-26");
  assert.equal(result.weeks[1].marketingSpend, 900);
  assert.equal(result.totals.marketingBudget, 1700);
  assert.equal(result.totals.marketingSpend, 1700);
});

test("rolls Shopify receipts, P&L costs, supplier payments, and manual movements through cash", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 2,
    asOfDate: "2026-07-20",
    openingBalance: 10000,
    receiptLagBusinessDays: 3,
    forecastAov: 100,
    forecastItemsPerOrder: 2,
    budgets: [{ weekStart: "2026-07-20", amount: 7000 }, { weekStart: "2026-07-27", amount: 7000 }],
    costRules: [
      { id: "fees", name: "Payment fees", category: "Payment", costType: "percent_revenue", rate: 0.02, status: "Active" },
      { id: "rent", name: "Rent", category: "Overheads", costType: "fixed_monthly", amount: 3100, status: "Active" }
    ],
    costForecasts: [{ id: "meta", name: "Meta forecast", costClass: "marketing", calculationType: "fixed", dueDate: "2026-07-26", amount: 700 }],
    supplierMovements: [{ id: "supplier", date: "2026-07-23", direction: "outflow", category: "Supplier payments", name: "PO 100", amount: 2000 }],
    manualMovements: [{ id: "manual", date: "2026-07-24", direction: "inflow", category: "Other", name: "Director funding", amount: 500 }]
  });

  assert.equal(result.weeks[0].receiptsForecast, 2000);
  assert.equal(result.weeks[1].receiptsForecast, 7000);
  assert.equal(result.weeks[0].supplierPayments, 2000);
  assert.equal(result.weeks[0].marketingSpend, 700);
  assert.equal(result.weeks[0].variableCosts, 140);
  assert.equal(result.weeks[0].fixedCosts, 700);
  assert.equal(result.weeks[0].otherInflows, 500);
  assert.equal(result.weeks[0].closingCash, 8960);
  assert.equal(result.weeks[1].openingCash, 8960);
  assert.equal(result.weeks[1].closingCash, 15120);
});

test("keeps supplier COGS out of cashflow unless it is supplied as an order movement", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 1,
    asOfDate: "2026-07-20",
    openingBalance: 5000,
    budgets: [{ weekStart: "2026-07-20", amount: 700 }],
    dailyActuals: [{ date: "2026-07-19", despatch: 300, cogs: 9999 }]
  });
  assert.equal(result.weeks[0].supplierPayments, 0);
  assert.equal(result.weeks[0].closingCash, 5500);
});

test("uses selected payment dates for fixed marketing and P&L-driven forecast costs", () => {
  const dailyActuals = Array.from({ length: 31 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    despatch: 100,
    orders: 1,
    units: 2
  }));
  const result = buildCashflow({
    startDate: "2026-07-27",
    weeks: 1,
    asOfDate: "2026-08-01",
    openingBalance: 5000,
    dailyActuals,
    costRules: [
      { id: "warehouse", name: "Warehouse pick", category: "Fulfilment", costType: "per_order", amount: 2, status: "Active" },
      { id: "excluded", name: "Excluded overhead", category: "Overheads", costType: "per_order", amount: 100, status: "Active" }
    ],
    costTiming: {
      warehouse: { enabled: true, paymentTiming: "scheduled" },
      excluded: { enabled: false, paymentTiming: "scheduled" }
    },
    costForecasts: [
      { id: "warehouse-july", name: "Warehouse July", costClass: "variable", calculationType: "pnl_rule", pnlRuleId: "warehouse", serviceStartDate: "2026-07-01", serviceEndDate: "2026-07-31", paymentDate: "2026-07-31" },
      { id: "meta-july", name: "Meta forecast", costClass: "marketing", calculationType: "fixed", paymentDate: "2026-07-29", amount: 310 }
    ]
  });

  assert.equal(result.weeks[0].variableCosts, 62);
  assert.equal(result.weeks[0].marketingSpend, 310);
  assert.equal(result.weeks[0].movements.find(row => row.name === "Warehouse July").date, "2026-07-31");
  assert.equal(result.weeks[0].movements.find(row => row.name === "Meta forecast").date, "2026-07-29");
  assert.equal(result.weeks[0].movements.some(row => row.name === "Excluded overhead"), false);
});

test("uses the previous calendar month for a scheduled P&L payment", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 4,
    asOfDate: "2026-07-19",
    openingBalance: 1000,
    forecastAov: 100,
    forecastItemsPerOrder: 2,
    budgets: [
      { weekStart: "2026-07-20", amount: 7000 },
      { weekStart: "2026-07-27", amount: 7000 },
      { weekStart: "2026-08-03", amount: 7000 },
      { weekStart: "2026-08-10", amount: 7000 }
    ],
    costRules: [{ id: "warehouse", name: "Warehouse", status: "Active", costType: "per_order", amount: 2 }],
    costTiming: { warehouse: { enabled: true, paymentTiming: "scheduled", paymentDate: "2026-08-12" } }
  });

  const paymentWeek = result.weeks.find(row => row.startDate === "2026-08-10");
  const movement = paymentWeek.movements.find(row => row.name === "Warehouse");
  assert.equal(paymentWeek.variableCosts, 240);
  assert.equal(movement.date, "2026-08-12");
  assert.match(movement.notes, /2026-07-01 to 2026-07-31/);
  assert.match(movement.notes, /in arrears/);
  assert.equal(result.weeks.filter(row => row.variableCosts > 0).length, 1);
});

test("calculates an in-horizon payment from a complete prior calendar month", () => {
  const result = buildCashflow({
    startDate: "2026-11-02",
    weeks: 1,
    asOfDate: "2026-11-02",
    openingBalance: 1000,
    dailyActuals: Array.from({ length: 31 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      despatch: 100,
      orders: 1,
      units: 2
    })),
    costRules: [{ id: "warehouse", name: "Warehouse", status: "Active", costType: "per_order", amount: 2 }],
    costTiming: { warehouse: { enabled: true, paymentTiming: "scheduled", paymentDate: "2026-11-06" } }
  });

  const movement = result.weeks[0].movements.find(row => row.name === "Warehouse");
  assert.equal(result.weeks[0].variableCosts, 62);
  assert.equal(movement.date, "2026-11-06");
  assert.match(movement.notes, /2026-10-01 to 2026-10-31/);
});

test("recurs a P&L rule monthly on the anchor day inside the horizon", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 13,
    asOfDate: "2026-07-19",
    openingBalance: 10000,
    costRules: [{ id: "rent", name: "Rent", status: "Active", costType: "fixed_monthly", amount: 1000 }],
    costTiming: { rent: { enabled: true, paymentTiming: "scheduled", paymentDate: "2026-07-15" } }
  });

  const movements = result.weeks.flatMap(row => row.movements).filter(row => row.name === "Rent");
  assert.deepEqual(movements.map(row => row.date), ["2026-08-15", "2026-09-15", "2026-10-15"]);
  assert.equal(result.totals.fixedCosts, 3000);
});

test("clamps monthly payment anchors to the final day of shorter months", () => {
  assert.deepEqual(monthlyPaymentDates("2026-01-31", "2026-01-01", "2026-04-30"), [
    "2026-01-31",
    "2026-02-28",
    "2026-03-31",
    "2026-04-30"
  ]);
});

test("builds quarterly UK VAT periods and moves weekend deadlines to Friday", () => {
  assert.equal(vatPaymentDate("2026-06-30"), "2026-08-07");
  assert.equal(vatPaymentDate("2026-09-30"), "2026-11-06");
  assert.deepEqual(quarterlyVatPeriods("2026-06-30", "2026-07-20", "2026-11-08"), [
    { periodStart: "2026-04-01", periodEnd: "2026-06-30", paymentDate: "2026-08-07" },
    { periodStart: "2026-07-01", periodEnd: "2026-09-30", paymentDate: "2026-11-06" }
  ]);
  assert.deepEqual(quarterlyVatPeriods("2026-09-30", "2026-11-01", "2027-02-28"), [
    { periodStart: "2026-07-01", periodEnd: "2026-09-30", paymentDate: "2026-11-06" },
    { periodStart: "2026-10-01", periodEnd: "2026-12-31", paymentDate: "2027-02-05" }
  ]);
});

test("forecasts VAT from actual Shopify tax and future Despatch, then applies recovery and an override", () => {
  const result = buildCashflow({
    startDate: "2026-07-20",
    weeks: 16,
    asOfDate: "2026-07-22",
    openingBalance: 1000,
    budgets: [{ weekStart: "2026-07-20", amount: 720 }],
    dailyActuals: [
      { date: "2026-07-01", despatch: 60, tax: 10 },
      { date: "2026-07-20", despatch: 120, tax: 20 }
    ],
    vatSettings: { enabled: true, periodEndAnchor: "2026-06-30", inputRecoveryPercent: 25 },
    vatOverrides: [{ periodEnd: "2026-09-30", amount: 90, notes: "Filed estimate" }]
  });

  const september = result.vat.periods.find(row => row.periodEnd === "2026-09-30");
  assert.equal(september.actualOutputVat, 30);
  assert.equal(september.forecastOutputVat, 100);
  assert.equal(september.calculatedAmount, 97.5);
  assert.equal(september.paymentAmount, 90);
  assert.equal(september.overridden, true);
  assert.equal(result.totals.vatPayments, 90);
  assert.equal(result.weeks.find(row => row.startDate === "2026-11-02").vatPayments, 90);
  assert.equal(result.totals.closingCash, 1630);
});

test("falls back to standard-rate VAT for actual Despatch without Shopify tax", () => {
  const result = buildCashflow({
    startDate: "2026-08-03",
    weeks: 1,
    asOfDate: "2026-08-03",
    dailyActuals: [{ date: "2026-06-30", despatch: 120 }],
    vatSettings: { enabled: true, periodEndAnchor: "2026-06-30", inputRecoveryPercent: 0 }
  });

  assert.equal(result.vat.periods[0].actualOutputVat, 20);
  assert.equal(result.totals.vatPayments, 20);
  assert.match(result.vat.warnings[0], /no Shopify tax value/);
});

test("does not add VAT movements when forecasting is disabled or unconfigured", () => {
  const disabled = buildCashflow({
    startDate: "2026-08-03",
    weeks: 1,
    vatSettings: { enabled: false, periodEndAnchor: "2026-06-30" }
  });
  const unconfigured = buildCashflow({
    startDate: "2026-08-03",
    weeks: 1,
    vatSettings: { enabled: true, periodEndAnchor: "" }
  });

  assert.equal(disabled.totals.vatPayments, 0);
  assert.equal(disabled.vat.periods.length, 0);
  assert.equal(unconfigured.totals.vatPayments, 0);
  assert.equal(unconfigured.vat.configured, false);
});
