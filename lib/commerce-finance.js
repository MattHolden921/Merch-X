"use strict";

const STANDARD_VAT_RATE = 0.2;
const FINANCIAL_FORMULA_VERSION = "shopifyql-sales-v2";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function vatDivisor(vatRate = STANDARD_VAT_RATE) {
  return 1 + Math.max(0, number(vatRate));
}

function excludingVat(value, options = {}) {
  const amount = number(value);
  return options.includesVat === false ? amount : amount / vatDivisor(options.vatRate);
}

function includingVat(value, options = {}) {
  const amount = number(value);
  return options.includesVat === true ? amount : amount * vatDivisor(options.vatRate);
}

function effectiveVatRate(netSalesExVat, shippingExVat, tax, returnFeesExVat = 0) {
  const taxableBase = Math.max(0, number(netSalesExVat) + number(shippingExVat) + number(returnFeesExVat));
  if (!taxableBase) return 0;
  return Math.max(0, number(tax) / taxableBase);
}

function demandRevenueFromParts(grossSalesExVat, discountsExVat, netSalesExVat, shippingExVat, tax, returnFeesExVat = 0) {
  const demandExVat = Math.max(0, number(grossSalesExVat) - Math.abs(number(discountsExVat)));
  if (!demandExVat) return 0;
  const value = demandExVat * (1 + effectiveVatRate(netSalesExVat, shippingExVat, tax, returnFeesExVat));
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function salesFinancials(input = {}) {
  const salesIncludeVat = Boolean(input.salesIncludeVat);
  const vatRate = number(input.vatRate, STANDARD_VAT_RATE);
  const netSales = number(input.netSales ?? input.revenue);
  const grossSales = number(input.grossSales, netSales);
  const netSalesExVat = excludingVat(netSales, { includesVat: salesIncludeVat, vatRate });
  const grossSalesExVat = excludingVat(grossSales, { includesVat: salesIncludeVat, vatRate });
  const netSalesIncVat = includingVat(netSales, { includesVat: salesIncludeVat, vatRate });
  const grossSalesIncVat = includingVat(grossSales, { includesVat: salesIncludeVat, vatRate });
  const costOfGoods = input.costOfGoods == null ? null : number(input.costOfGoods);
  const hasReportedGrossProfit = input.grossProfit != null;
  const grossProfit = input.grossProfit == null
    ? (costOfGoods == null ? null : netSalesExVat - costOfGoods)
    : number(input.grossProfit);
  // Shopify only includes sales with a recorded product cost in its reported
  // gross-profit and COGS metrics. Their matching revenue basis is therefore
  // reported GP + reported COGS, rather than the report's total net sales.
  const grossMarginRevenueExVat = input.costedNetSalesExVat == null
    ? (hasReportedGrossProfit && costOfGoods != null ? grossProfit + costOfGoods : netSalesExVat)
    : number(input.costedNetSalesExVat);
  return {
    netSales,
    grossSales,
    netSalesExVat,
    grossSalesExVat,
    netSalesIncVat,
    grossSalesIncVat,
    discountsExVat: grossSalesExVat - netSalesExVat,
    costOfGoods,
    grossProfit,
    grossMarginRevenueExVat,
    grossMargin: grossProfit == null || grossMarginRevenueExVat === 0 ? null : grossProfit / grossMarginRevenueExVat,
    salesIncludeVat,
    vatRate,
    formulaVersion: FINANCIAL_FORMULA_VERSION
  };
}

module.exports = {
  FINANCIAL_FORMULA_VERSION,
  STANDARD_VAT_RATE,
  demandRevenueFromParts,
  effectiveVatRate,
  excludingVat,
  includingVat,
  salesFinancials,
  vatDivisor
};
