"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const finance = require("../lib/commerce-finance");

test("canonical sales formulas normalize VAT before calculating GP and margin", () => {
  const result = finance.salesFinancials({
    grossSales: 180,
    netSales: 144,
    costOfGoods: 60,
    salesIncludeVat: true
  });
  assert.equal(result.grossSalesExVat, 150);
  assert.equal(result.netSalesExVat, 120);
  assert.equal(result.grossSalesIncVat, 180);
  assert.equal(result.netSalesIncVat, 144);
  assert.equal(result.discountsExVat, 30);
  assert.equal(result.grossProfit, 60);
  assert.equal(result.grossMargin, 0.5);
});

test("ShopifyQL ex-VAT values and reported GP are preserved exactly", () => {
  const result = finance.salesFinancials({
    grossSales: 27043.43,
    netSales: 16809.3,
    costOfGoods: 2525.5,
    grossProfit: 14283.8,
    salesIncludeVat: false
  });
  assert.equal(result.grossSalesExVat, 27043.43);
  assert.equal(result.netSalesExVat, 16809.3);
  assert.equal(result.netSalesIncVat, 20171.16);
  assert.ok(Math.abs(result.grossSalesIncVat - 32452.116) < 1e-9);
  assert.equal(result.grossProfit, 14283.8);
  assert.equal(result.grossMarginRevenueExVat, 14283.8 + 2525.5);
  assert.equal(result.grossMargin, 14283.8 / (14283.8 + 2525.5));
  assert.equal(result.formulaVersion, finance.FINANCIAL_FORMULA_VERSION);
});

test("VAT-inclusive merchandising values can be derived without changing canonical ex-VAT amounts", () => {
  assert.equal(finance.includingVat(100, { includesVat: false }), 120);
  assert.equal(finance.includingVat(120, { includesVat: true }), 120);
  assert.equal(finance.excludingVat(120, { includesVat: true }), 100);
});

test("Demand uses the shared P&L bridge formula", () => {
  assert.equal(finance.demandRevenueFromParts(27043.43, 1742.36, 16809.3, 705.06, 3595.04, 0), 30494.43);
});
