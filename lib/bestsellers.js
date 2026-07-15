"use strict";

const finance = require("./commerce-finance");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const TRADE_METRICS_VERSION = "pnl-demand-despatch-returns-fp-v4";

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  const text = String(value || "");
  if (!ISO_DATE.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || isoDateOnly(date) !== text) return null;
  return date;
}

function validIsoDate(value) {
  return Boolean(parseIsoDate(value));
}

function validateRange(range, maxDays = 367) {
  const start = parseIsoDate(range?.startDate);
  const end = parseIsoDate(range?.endDate);
  if (!start || !end) throw new Error("Use real calendar dates in YYYY-MM-DD format.");
  if (end < start) throw new Error("The report end date must be on or after the start date.");
  const days = Math.floor((end - start) / DAY_MS) + 1;
  if (days > maxDays) throw new Error(`Choose a report range of ${maxDays - 1} days or less.`);
  return { startDate: isoDateOnly(start), endDate: isoDateOnly(end), days };
}

function isCanonicalMondaySundayWeek(period) {
  const start = parseIsoDate(period?.startDate ?? period?.start_date);
  const end = parseIsoDate(period?.endDate ?? period?.end_date);
  return Boolean(start && end && start.getUTCDay() === 1 && end.getUTCDay() === 0 && (end - start) / DAY_MS === 6);
}

function contiguousWeekRanges(periods) {
  const canonical = (periods || [])
    .filter(isCanonicalMondaySundayWeek)
    .slice()
    .sort((a, b) => String(b.startDate ?? b.start_date).localeCompare(String(a.startDate ?? a.start_date)));
  const groups = [];
  for (const period of canonical) {
    const startDate = String(period.startDate ?? period.start_date);
    const endDate = String(period.endDate ?? period.end_date);
    const last = groups[groups.length - 1];
    const expectedPreviousEnd = last ? new Date(`${last.startDate}T00:00:00.000Z`) : null;
    if (expectedPreviousEnd) expectedPreviousEnd.setUTCDate(expectedPreviousEnd.getUTCDate() - 1);
    if (!last || endDate !== isoDateOnly(expectedPreviousEnd)) {
      groups.push({ startDate, endDate, weekCount: 1, periodIds: period.id ? [period.id] : [] });
    } else {
      last.startDate = startDate;
      last.weekCount += 1;
      if (period.id) last.periodIds.push(period.id);
    }
  }
  return groups;
}

function moneyAmount(value) {
  const amount = value?.shopMoney?.amount ?? value?.amount ?? value;
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyOrderMetric() {
  return {
    revenue: 0,
    grossSales: 0,
    discounts: 0,
    returns: 0,
    units: 0,
    grossUnits: 0,
    returnedUnits: 0,
    salesIncludeVat: false,
    source: "order_api_fallback",
    variants: new Map()
  };
}

function addOrderLineMetric(metrics, item) {
  if (!metrics || !item?.product?.id || item.isGiftCard) return false;
  const orderedQuantity = Math.max(0, Number(item.quantity || 0));
  const netQuantity = Math.max(0, Number(item.currentQuantity ?? orderedQuantity));
  if (!orderedQuantity) return false;
  const retainedRatio = Math.min(1, netQuantity / orderedQuantity);
  const currentDiscountedTotal = item.priceAfterAllDiscountsBeforeTaxesSet == null
    ? null
    : moneyAmount(item.priceAfterAllDiscountsBeforeTaxesSet);
  const allDiscountsUnitPrice = item.discountedUnitPriceAfterAllDiscountsSet == null
    ? null
    : moneyAmount(item.discountedUnitPriceAfterAllDiscountsSet);
  const revenue = currentDiscountedTotal == null
    ? (allDiscountsUnitPrice == null
        ? moneyAmount(item.discountedTotalSet) * retainedRatio
        : allDiscountsUnitPrice * netQuantity)
    : currentDiscountedTotal;
  const grossSales = moneyAmount(item.originalTotalSet ?? item.discountedTotalSet) * retainedRatio;
  const fullDiscountedTotal = allDiscountsUnitPrice == null
    ? moneyAmount(item.discountedTotalSet)
    : allDiscountsUnitPrice * orderedQuantity;
  const fullGrossSales = moneyAmount(item.originalTotalSet ?? item.discountedTotalSet);
  const returnedUnits = Math.max(0, orderedQuantity - netQuantity);
  const returns = orderedQuantity > 0 ? fullDiscountedTotal * (returnedUnits / orderedQuantity) : 0;
  const discounts = Math.max(0, fullGrossSales - fullDiscountedTotal) * retainedRatio;
  const productId = item.product.id;
  const variantId = item.variant?.id || "unresolved";
  const current = metrics.get(productId) || emptyOrderMetric();
  current.revenue += revenue;
  current.grossSales += grossSales;
  current.discounts += discounts;
  current.returns += returns;
  current.units += netQuantity;
  current.grossUnits += orderedQuantity;
  current.returnedUnits += returnedUnits;
  const variant = current.variants.get(variantId) || { revenue: 0, grossSales: 0, discounts: 0, returns: 0, units: 0, grossUnits: 0, returnedUnits: 0 };
  variant.revenue += revenue;
  variant.grossSales += grossSales;
  variant.discounts += discounts;
  variant.returns += returns;
  variant.units += netQuantity;
  variant.grossUnits += orderedQuantity;
  variant.returnedUnits += returnedUnits;
  current.variants.set(variantId, variant);
  metrics.set(productId, current);
  return true;
}

function assertCompleteOrderLineConnection(connection) {
  if (connection?.pageInfo?.hasNextPage) {
    throw new Error("A Shopify order has more than 250 line items. Bestsellers sync stopped to avoid saving incomplete sales metrics.");
  }
  if (!Array.isArray(connection?.nodes)) {
    throw new Error("Shopify returned no readable order line items. Bestsellers sync stopped to protect the saved report.");
  }
  return connection.nodes;
}

function variantCost(variant) {
  const raw = variant?.cost ?? variant?.inventoryItem?.unitCost?.amount;
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function variantIdentifiers(variant) {
  return [variant?.id, variant?.legacyResourceId == null ? "" : String(variant.legacyResourceId)].filter(Boolean);
}

function currentInventoryWeightedCost(variants) {
  let units = 0;
  let value = 0;
  const fallback = [];
  for (const variant of variants || []) {
    const cost = variantCost(variant);
    if (cost == null) continue;
    fallback.push(cost);
    const stock = Math.max(0, Number(variant.inventoryQuantity || 0));
    units += stock;
    value += stock * cost;
  }
  if (units > 0) return value / units;
  return fallback.length ? fallback.reduce((sum, cost) => sum + cost, 0) / fallback.length : null;
}

function storedGrossProfit(row, data = {}, units = Number(row?.units || 0), options = {}) {
  if (row?.gross_profit == null) return null;
  const hasExplicitCoverage = data.costQuality != null
    || data.costCoveragePercent != null
    || data.costedUnits != null
    || data.uncostedUnits != null;
  const legacyMissingCost = Number(units || 0) > 0
    && !hasExplicitCoverage
    && row.cost == null
    && data.cost == null;
  if (legacyMissingCost) return null;
  let value = Number(row.gross_profit);
  if (!Number.isFinite(value)) return null;
  if (options.salesIncludeVat && options.revenueBasis !== "ex_vat") {
    const revenue = Number(options.revenue || 0);
    const revenueExVat = Number(options.revenueExVat || 0);
    value += revenueExVat - revenue;
  }
  return value;
}

function storedSalesFinancials(row = {}, data = {}, summary = {}, options = {}) {
  const vatRate = options.vatRate ?? finance.STANDARD_VAT_RATE;
  const storedSalesIncludeVat = summary.storedSalesValuesIncludeVat === true;
  const storedNetSales = Number(row.net_sales || 0);
  const storedGrossSales = row.gross_sales == null ? storedNetSales : Number(row.gross_sales || 0);
  const explicitNetExVat = data.revenueExVat == null ? null : Number(data.revenueExVat);
  const explicitGrossExVat = data.grossSalesExVat == null ? null : Number(data.grossSalesExVat);
  const normalized = finance.salesFinancials({
    netSales: storedNetSales,
    grossSales: storedGrossSales,
    salesIncludeVat: storedSalesIncludeVat,
    vatRate
  });
  const netSalesExVat = Number.isFinite(explicitNetExVat) ? explicitNetExVat : normalized.netSalesExVat;
  const grossSalesExVat = Number.isFinite(explicitGrossExVat) ? explicitGrossExVat : normalized.grossSalesExVat;
  return {
    netSalesExVat,
    grossSalesExVat,
    netSalesIncVat: finance.includingVat(netSalesExVat, { includesVat: false, vatRate }),
    grossSalesIncVat: finance.includingVat(grossSalesExVat, { includesVat: false, vatRate }),
    storedSalesIncludeVat,
    vatRate
  };
}

function combineTradingMetrics(periods = []) {
  const periodMetrics = {};
  const bridgeKeys = ["grossRevenue", "discounts", "returns", "netRevenue", "shippingRevenue", "tax", "returnFees", "grossUnits", "returnedUnits", "netUnits"];
  for (const period of periods) {
    const label = String(period?.label || "");
    const metrics = period?.summary?.tradingMetrics;
    const demand = metrics == null ? NaN : Number(metrics.demandRevenue);
    const despatch = metrics == null ? NaN : Number(metrics.despatchRevenue);
    const bridge = Object.fromEntries(bridgeKeys.map(key => [key, metrics == null ? NaN : Number(metrics[key])]));
    const bridgeAvailable = Object.values(bridge).every(Number.isFinite);
    const available = Number.isFinite(demand) && Number.isFinite(despatch) && bridgeAvailable;
    periodMetrics[label] = {
      available,
      demandRevenue: available ? demand : null,
      despatchRevenue: available ? despatch : null,
      bridge: available ? bridge : null
    };
  }
  function aggregate(selectedPeriods) {
    const bridgeTotals = Object.fromEntries(bridgeKeys.map(key => [key, 0]));
    let despatchRevenue = 0;
    let complete = selectedPeriods.length > 0;
    for (const period of selectedPeriods) {
      const metric = periodMetrics[String(period?.label || "")];
      if (!metric?.available) {
        complete = false;
        continue;
      }
      despatchRevenue += Number(metric.despatchRevenue || 0);
      for (const key of bridgeKeys) bridgeTotals[key] += Number(metric.bridge[key] || 0);
    }
    return {
      available: complete,
      demandRevenue: complete
        ? finance.demandRevenueFromParts(
            bridgeTotals.grossRevenue,
            bridgeTotals.discounts,
            bridgeTotals.netRevenue,
            bridgeTotals.shippingRevenue,
            bridgeTotals.tax,
            bridgeTotals.returnFees
          )
        : null,
      despatchRevenue: complete ? despatchRevenue : null,
      grossRevenue: complete ? bridgeTotals.grossRevenue : null,
      discounts: complete ? bridgeTotals.discounts : null,
      returns: complete ? bridgeTotals.returns : null,
      grossUnits: complete ? bridgeTotals.grossUnits : null,
      returnedUnits: complete ? bridgeTotals.returnedUnits : null,
      netUnits: complete ? bridgeTotals.netUnits : null
    };
  }
  const combined = aggregate(periods);
  const selections = {};
  for (const count of [1, 2, 3, 4, 6, 8]) {
    if (count < periods.length) selections[`last${count}`] = aggregate(periods.slice(-count));
  }
  return {
    ...combined,
    periods: periodMetrics,
    selections,
    source: "shopifyql_sales",
    version: TRADE_METRICS_VERSION
  };
}

function calculateProductFinancials(metric, variants, options = {}) {
  const normalizedOptions = typeof options === "number" ? { vatRate: options } : options;
  const vatRate = normalizedOptions.vatRate ?? finance.STANDARD_VAT_RATE;
  const salesIncludeVat = metric?.salesIncludeVat == null
    ? normalizedOptions.salesIncludeVat !== false
    : Boolean(metric.salesIncludeVat);
  const revenue = Number(metric?.revenue || 0);
  const grossSales = Number(metric?.grossSales ?? revenue);
  const units = Number(metric?.units || 0);
  const grossUnits = Math.max(0, Number(metric?.grossUnits ?? units + Number(metric?.returnedUnits || 0)));
  const returnedUnits = Math.max(0, Number(metric?.returnedUnits ?? grossUnits - units));
  const discountsExVat = Math.abs(Number(metric?.discounts || 0));
  const refundsExVat = Math.abs(Number(metric?.returns || 0));
  const divisor = salesIncludeVat ? finance.vatDivisor(vatRate) : 1;
  const byId = new Map();
  for (const variant of variants || []) {
    for (const id of variantIdentifiers(variant)) byId.set(id, variant);
  }
  const salesByVariant = metric?.variants instanceof Map
    ? metric.variants
    : new Map(Object.entries(metric?.variants || {}));
  let costedUnits = 0;
  let costOfGoods = 0;
  let costedRevenue = 0;
  let knownGrossProfit = 0;
  let rrpOpportunityIncVat = 0;
  let fullPriceGrossUnits = 0;
  let markdownGrossUnits = 0;
  let fullPriceGrossSalesIncVat = 0;
  let markdownGrossSalesIncVat = 0;
  for (const [variantId, sold] of salesByVariant) {
    const soldUnits = Math.max(0, Number(sold?.units || 0));
    if (!soldUnits) continue;
    const cost = variantCost(byId.get(String(variantId)));
    if (cost == null) continue;
    const variantRevenue = Number(sold?.revenue || 0);
    costedUnits += soldUnits;
    costOfGoods += soldUnits * cost;
    costedRevenue += variantRevenue;
    knownGrossProfit += variantRevenue / divisor - soldUnits * cost;
  }
  for (const [variantId, sold] of salesByVariant) {
    const soldGrossUnits = Math.max(0, Number(sold?.grossUnits ?? Number(sold?.units || 0) + Number(sold?.returnedUnits || 0)));
    if (!soldGrossUnits) continue;
    const variant = byId.get(String(variantId)) || ((variants || []).length === 1 ? variants[0] : null);
    const price = Number(variant?.price);
    if (!(price >= 0)) continue;
    const compareAt = Number(variant?.compareAtPrice);
    const rrp = Number.isFinite(compareAt) && compareAt > price ? compareAt : price;
    const grossSalesIncVat = finance.includingVat(Number(sold?.grossSales || 0), { includesVat: salesIncludeVat, vatRate });
    const preDiscountUnitPrice = grossSalesIncVat > 0 ? grossSalesIncVat / soldGrossUnits : price;
    const markedDown = preDiscountUnitPrice + 0.01 < rrp;
    rrpOpportunityIncVat += soldGrossUnits * rrp;
    if (markedDown) {
      markdownGrossUnits += soldGrossUnits;
      markdownGrossSalesIncVat += grossSalesIncVat;
    } else {
      fullPriceGrossUnits += soldGrossUnits;
      fullPriceGrossSalesIncVat += grossSalesIncVat;
    }
  }
  let stockCostValue = 0;
  let stockRetailValue = 0;
  let stockCostedUnits = 0;
  let stockUncostedUnits = 0;
  let stockUnpricedUnits = 0;
  for (const variant of variants || []) {
    const stockUnits = Math.max(0, Number(variant.inventoryQuantity || 0));
    if (!stockUnits) continue;
    const retail = Number(variant.price);
    if (Number.isFinite(retail) && retail >= 0) stockRetailValue += stockUnits * retail;
    else stockUnpricedUnits += stockUnits;
    const currentCost = variantCost(variant);
    if (currentCost == null) stockUncostedUnits += stockUnits;
    else {
      stockCostedUnits += stockUnits;
      stockCostValue += stockUnits * currentCost;
    }
  }
  const reportedFinancials = metric?.source === "shopifyql_sales"
    ? finance.salesFinancials({
        netSales: revenue,
        grossSales,
        costOfGoods: metric.costOfGoods,
        grossProfit: metric.grossProfit,
        salesIncludeVat: false,
        vatRate
      })
    : null;
  const canonicalFinancials = reportedFinancials || finance.salesFinancials({
    netSales: revenue,
    grossSales,
    salesIncludeVat,
    vatRate
  });
  const positiveUnits = Math.max(0, units);
  const uncostedUnits = reportedFinancials ? 0 : Math.max(0, positiveUnits - costedUnits);
  const complete = Boolean(reportedFinancials) || positiveUnits === 0 || uncostedUnits < 1e-9;
  const coveragePercent = reportedFinancials ? 100 : positiveUnits > 0 ? Math.min(100, costedUnits / positiveUnits * 100) : 100;
  const averageSoldUnitCost = costedUnits > 0 ? costOfGoods / costedUnits : null;
  const currentInventoryCost = currentInventoryWeightedCost(variants);
  return {
    revenue,
    revenueExVat: canonicalFinancials.netSalesExVat,
    revenueIncVat: canonicalFinancials.netSalesIncVat,
    grossSales,
    grossSalesExVat: canonicalFinancials.grossSalesExVat,
    grossSalesIncVat: canonicalFinancials.grossSalesIncVat,
    discountsExVat,
    discountsIncVat: finance.includingVat(discountsExVat, { includesVat: false, vatRate }),
    refundsExVat,
    refundsIncVat: finance.includingVat(refundsExVat, { includesVat: false, vatRate }),
    units,
    grossUnits,
    returnedUnits,
    fullPriceGrossUnits,
    markdownGrossUnits,
    fullPriceGrossSalesIncVat,
    markdownGrossSalesIncVat,
    rrpOpportunityIncVat,
    markdownLeakageIncVat: Math.max(0, rrpOpportunityIncVat - canonicalFinancials.grossSalesIncVat),
    grossProfit: reportedFinancials?.grossProfit ?? (complete ? revenue / divisor - costOfGoods : null),
    knownGrossProfit: reportedFinancials?.grossProfit ?? knownGrossProfit,
    costOfGoods: reportedFinancials?.costOfGoods ?? (complete ? costOfGoods : null),
    knownCostOfGoods: reportedFinancials?.costOfGoods ?? costOfGoods,
    cost: currentInventoryCost ?? averageSoldUnitCost,
    currentInventoryCost,
    averageSoldUnitCost,
    costedUnits: reportedFinancials ? positiveUnits : costedUnits,
    uncostedUnits,
    costedRevenue: reportedFinancials ? revenue : costedRevenue,
    costedRevenueExVat: reportedFinancials?.grossMarginRevenueExVat ?? costedRevenue / divisor,
    costCoveragePercent: coveragePercent,
    costQuality: reportedFinancials ? "shopify_reported" : units === 0 ? "not_applicable" : complete ? "complete" : costedUnits > 0 ? "partial" : "missing",
    stockCostValue,
    stockRetailValue,
    stockCostedUnits,
    stockUncostedUnits,
    stockUnpricedUnits,
    stockCostCoveragePercent: stockCostedUnits + stockUncostedUnits > 0
      ? stockCostedUnits / (stockCostedUnits + stockUncostedUnits) * 100
      : 100
  };
}

function decisionRateMetrics(latest, stock, periodDays = 7, forecastWeeks = 8) {
  const weeks = Math.max(Number(periodDays || 0) / 7, 1 / 7);
  const decisionUnits = Number(latest?.units || 0);
  const decisionRevenue = Number(latest?.rev ?? latest?.revenue ?? 0);
  const weeklyUnits = decisionUnits / weeks;
  const weeklyRevenue = decisionRevenue / weeks;
  const numericStock = stock == null ? null : Number(stock || 0);
  return {
    decisionUnits,
    decisionRevenue,
    wklyU: weeklyUnits,
    avgRevPerWeek: weeklyRevenue,
    coverWks: numericStock != null && weeklyUnits > 0 ? numericStock / weeklyUnits : null,
    forecastBuy: numericStock != null && weeklyUnits > 0 ? Math.max(0, Math.ceil(weeklyUnits * forecastWeeks) - numericStock) : null
  };
}

function isGiftCardProduct(product) {
  return Boolean(product?.isGiftCard) || /^gift\s*card$/i.test(String(product?.title || "").trim());
}

function weeklyActionEligible(product) {
  if (!product || isGiftCardProduct(product)) return false;
  const status = String(product.shopifyStatus || product.status || product.data?.shopifyStatus || "").trim().toUpperCase();
  return status === "ACTIVE";
}

function isStaleSyncJob(row, now = Date.now(), timeoutMs = 2 * 60 * 60 * 1000) {
  if (!row || !["queued", "running"].includes(row.status)) return false;
  const updatedAt = new Date(row.updated_at || row.created_at || "").getTime();
  return Number.isFinite(updatedAt) && updatedAt < Number(now) - timeoutMs;
}

function recoverReportSyncJobs(db) {
  const interrupted = db.prepare(`
    UPDATE report_sync_jobs
    SET status = 'error',
        error = 'Sync interrupted by a server restart before completion.',
        message = 'Sync interrupted by a server restart before completion.',
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE report_type = 'bestsellers' AND status IN ('queued', 'running')
  `).run().changes;
  const payloadsCleared = db.prepare(`
    UPDATE report_sync_jobs
    SET result_json = NULL
    WHERE report_type = 'bestsellers'
      AND status IN ('complete', 'error')
      AND datetime(COALESCE(completed_at, updated_at)) < datetime('now', '-14 days')
  `).run().changes;
  const jobsDeleted = db.prepare(`
    DELETE FROM report_sync_jobs
    WHERE report_type = 'bestsellers'
      AND status IN ('complete', 'error')
      AND datetime(COALESCE(completed_at, updated_at)) < datetime('now', '-90 days')
  `).run().changes;
  return { interrupted, payloadsCleared, jobsDeleted };
}

module.exports = {
  TRADE_METRICS_VERSION,
  addOrderLineMetric,
  assertCompleteOrderLineConnection,
  calculateProductFinancials,
  combineTradingMetrics,
  contiguousWeekRanges,
  decisionRateMetrics,
  isCanonicalMondaySundayWeek,
  isGiftCardProduct,
  isStaleSyncJob,
  parseIsoDate,
  storedGrossProfit,
  storedSalesFinancials,
  validIsoDate,
  validateRange,
  recoverReportSyncJobs,
  weeklyActionEligible
};
