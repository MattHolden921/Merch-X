"use strict";

const finance = require("./commerce-finance");

const COST_TYPES = new Set(["fixed_monthly", "per_order", "per_item", "pick_pack", "percent_revenue", "percent_revenue_plus_per_order"]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function number(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function money(value) {
  const numeric = number(value);
  return Math.round(numeric * 100) / 100;
}

function rate(value) {
  const numeric = number(value);
  if (Math.abs(numeric) > 1) return numeric / 100;
  return numeric;
}

function parseDate(value) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysInclusive(startDate, endDate) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || start > end) return 0;
  return Math.floor((end - start) / 864e5) + 1;
}

function validateRange(range = {}, options = {}) {
  const startDate = text(range.startDate);
  const endDate = text(range.endDate);
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || start > end) throw new Error("Choose a valid P&L date range.");
  const days = daysInclusive(startDate, endDate);
  const maxDays = Math.max(1, number(options.maxDays, 92));
  if (days > maxDays) throw new Error(`Choose a P&L range of ${maxDays} days or less.`);
  return { startDate, endDate, days };
}

function overlapDays(aStart, aEnd, bStart, bEnd) {
  const startA = parseDate(aStart);
  const endA = parseDate(aEnd);
  const startB = parseDate(bStart);
  const endB = parseDate(bEnd);
  if (!startA || !endA || !startB || !endB) return 0;
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;
  if (start > end) return 0;
  return Math.floor((end - start) / 864e5) + 1;
}

function activeWindow(item = {}, range) {
  const effectiveStart = text(item.effectiveStart || item.startDate || range.startDate) || range.startDate;
  const effectiveEnd = text(item.effectiveEnd || item.endDate || range.endDate) || range.endDate;
  return {
    startDate: parseDate(effectiveStart) ? effectiveStart : range.startDate,
    endDate: parseDate(effectiveEnd) ? effectiveEnd : range.endDate
  };
}

function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthEnd(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function daysInMonth(date) {
  return monthEnd(date).getUTCDate();
}

function fixedMonthlyCost(rule, range) {
  const monthlyAmount = number(rule.amount);
  if (!monthlyAmount) return { amount: 0, overlapDays: 0 };
  const window = activeWindow(rule, range);
  const start = parseDate(range.startDate);
  const end = parseDate(range.endDate);
  let cursor = monthStart(start);
  let total = 0;
  let activeDays = 0;
  while (cursor <= end) {
    const mStart = isoDate(monthStart(cursor));
    const mEnd = isoDate(monthEnd(cursor));
    const overlap = overlapDays(range.startDate, range.endDate, mStart, mEnd);
    const effectiveOverlap = overlapDays(window.startDate, window.endDate, mStart, mEnd);
    const days = Math.min(overlap, effectiveOverlap);
    if (days > 0) {
      total += monthlyAmount * (days / daysInMonth(cursor));
      activeDays += days;
    }
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return { amount: money(total), overlapDays: activeDays };
}

function publicRule(rule = {}) {
  const costType = COST_TYPES.has(text(rule.costType || rule.cost_type)) ? text(rule.costType || rule.cost_type) : "per_order";
  return {
    id: text(rule.id),
    name: text(rule.name) || "Cost rule",
    category: text(rule.category) || "Other",
    costType,
    status: text(rule.status || "Active") || "Active",
    effectiveStart: text(rule.effectiveStart || rule.effective_start),
    effectiveEnd: text(rule.effectiveEnd || rule.effective_end),
    amount: money(rule.amount),
    rate: rate(rule.rate),
    firstItemRate: money(rule.firstItemRate ?? rule.first_item_rate),
    additionalItemRate: money(rule.additionalItemRate ?? rule.additional_item_rate),
    notes: text(rule.notes),
    data: rule.data && typeof rule.data === "object" ? rule.data : {}
  };
}

function ruleIsActive(rule, range) {
  if (text(rule.status || "Active").toLowerCase() !== "active") return false;
  const window = activeWindow(rule, range);
  return overlapDays(range.startDate, range.endDate, window.startDate, window.endDate) > 0;
}

function costBaseForOverlap(base, rule, range) {
  const window = activeWindow(rule, range);
  const days = overlapDays(range.startDate, range.endDate, window.startDate, window.endDate);
  const ratio = range.days > 0 ? days / range.days : 0;
  return {
    ratio,
    days,
    netRevenue: number(base.netRevenue) * ratio,
    despatchRevenue: number(base.despatchRevenue || base.netRevenue) * ratio,
    orders: number(base.orders) * ratio,
    units: number(base.units) * ratio
  };
}

function calculateCostRule(ruleInput, baseInput, rangeInput) {
  const range = validateRange(rangeInput);
  const rule = publicRule(ruleInput);
  const base = normalizeActuals({ ...baseInput, range });
  if (!ruleIsActive(rule, range)) {
    return { ...rule, amountApplied: 0, overlapDays: 0, formula: "" };
  }
  const overlapped = costBaseForOverlap(base, rule, range);
  let amountApplied = 0;
  let orderDrivenAmount = 0;
  let revenueDrivenAmount = 0;
  let formula = "";
  if (rule.costType === "fixed_monthly") {
    const fixed = fixedMonthlyCost(rule, range);
    amountApplied = fixed.amount;
    formula = `${money(rule.amount)} monthly prorated`;
    overlapped.days = fixed.overlapDays;
  } else if (rule.costType === "per_order") {
    amountApplied = rule.amount * overlapped.orders;
    orderDrivenAmount = amountApplied;
    formula = `${money(rule.amount)} per order`;
  } else if (rule.costType === "per_item") {
    amountApplied = rule.amount * overlapped.units;
    orderDrivenAmount = amountApplied;
    formula = `${money(rule.amount)} per item`;
  } else if (rule.costType === "pick_pack") {
    amountApplied = rule.firstItemRate * overlapped.orders + rule.additionalItemRate * Math.max(0, overlapped.units - overlapped.orders);
    orderDrivenAmount = amountApplied;
    formula = `${money(rule.firstItemRate)} first item + ${money(rule.additionalItemRate)} additional`;
  } else if (rule.costType === "percent_revenue") {
    amountApplied = rule.rate * overlapped.despatchRevenue;
    revenueDrivenAmount = amountApplied;
    formula = `${money(rule.rate * 100)}% of despatch`;
  } else if (rule.costType === "percent_revenue_plus_per_order") {
    revenueDrivenAmount = rule.rate * overlapped.despatchRevenue;
    orderDrivenAmount = rule.amount * overlapped.orders;
    amountApplied = revenueDrivenAmount + orderDrivenAmount;
    formula = `${money(rule.rate * 100)}% of despatch + ${money(rule.amount)} per order`;
  }
  return {
    ...rule,
    amountApplied: money(amountApplied),
    orderDrivenAmount: money(orderDrivenAmount),
    revenueDrivenAmount: money(revenueDrivenAmount),
    overlapDays: overlapped.days,
    formula
  };
}

function marketingEntryAmount(entry = {}, rangeInput) {
  const range = validateRange(rangeInput);
  const startDate = text(entry.startDate || entry.date || range.startDate);
  const endDate = text(entry.endDate || entry.date || startDate);
  const entryDays = daysInclusive(startDate, endDate) || 1;
  const days = overlapDays(range.startDate, range.endDate, startDate, endDate);
  return {
    amountApplied: money(number(entry.amount) * (days / entryDays)),
    overlapDays: days,
    entryDays
  };
}

function publicMarketingEntry(entry = {}, rangeInput = null) {
  const startDate = text(entry.startDate || entry.start_date || entry.date);
  const endDate = text(entry.endDate || entry.end_date || entry.date || startDate);
  const data = entry.data && typeof entry.data === "object" ? entry.data : {};
  const result = {
    id: text(entry.id),
    channel: text(entry.channel) || "Other",
    startDate,
    endDate,
    amount: money(entry.amount),
    notes: text(entry.notes),
    data,
    attributedRevenue: money(entry.attributedRevenue ?? entry.attributed_revenue ?? data.attributedRevenue),
    attributedRoas: money(entry.attributedRoas ?? entry.attributed_roas ?? data.attributedRoas),
    attributionWeight: number(entry.attributionWeight ?? data.attributionWeight, 1)
  };
  if (rangeInput) {
    const applied = marketingEntryAmount(result, rangeInput);
    result.amountApplied = applied.amountApplied;
    result.overlapDays = applied.overlapDays;
    result.attributedRevenueApplied = money(result.attributedRevenue * (applied.overlapDays / applied.entryDays));
    result.attributedRoasApplied = result.amountApplied > 0 ? money(result.attributedRevenueApplied / result.amountApplied) : 0;
  }
  return result;
}

function marketingEntryIsAutomated(entry = {}) {
  const data = entry.data && typeof entry.data === "object" ? entry.data : {};
  const source = text(entry.source);
  return Boolean(entry.automated || data.automated || (source && source.toLowerCase() !== "manual"));
}

function marketingChannelKey(entry = {}) {
  return text(entry.channel).toLowerCase();
}

function effectiveMarketingEntries(entries = []) {
  const publicEntries = entries.map(entry => ({ ...entry, ...publicMarketingEntry(entry) }));
  const automated = publicEntries.filter(marketingEntryIsAutomated);
  if (!automated.length) return publicEntries;
  return publicEntries.filter(entry => {
    if (marketingEntryIsAutomated(entry)) return true;
    const channel = marketingChannelKey(entry);
    return !automated.some(auto => marketingChannelKey(auto) === channel && overlapDays(entry.startDate, entry.endDate, auto.startDate, auto.endDate) > 0);
  });
}

function channelKey(value) {
  const clean = text(value).toLowerCase();
  if (["google", "google ads", "ppc", "paid search"].includes(clean)) return "Google";
  if (["meta", "facebook", "facebook ads", "paid social"].includes(clean)) return "Meta";
  return text(value) || "Other";
}

function marketingChannelGroups(marketingLines = []) {
  const groups = new Map();
  for (const line of marketingLines) {
    const channel = channelKey(line.channel);
    const current = groups.get(channel) || {
      channel,
      amount: 0,
      attributedRevenue: 0,
      attributionWeight: 1,
      weightedAmount: 0
    };
    const amount = number(line.amountApplied);
    const weight = number(line.attributionWeight, 1);
    current.amount += amount;
    current.attributedRevenue += number(line.attributedRevenueApplied);
    current.attributionWeight = current.weightedAmount + amount > 0
      ? ((current.attributionWeight * current.weightedAmount) + (weight * amount)) / (current.weightedAmount + amount)
      : weight;
    current.weightedAmount += amount;
    groups.set(channel, current);
  }
  return [...groups.values()].map(group => ({
    channel: group.channel,
    amount: money(group.amount),
    attributedRevenue: money(group.attributedRevenue),
    attributedRoas: group.amount > 0 ? money(group.attributedRevenue / group.amount) : 0,
    attributionWeight: Math.round(group.attributionWeight * 100) / 100
  })).sort((a, b) => {
    const order = { Google: 0, Meta: 1, Other: 2 };
    return (order[a.channel] ?? 9) - (order[b.channel] ?? 9) || a.channel.localeCompare(b.channel);
  });
}

function marketingForecastModel(actualPnl = {}, driversInput = {}) {
  const groups = marketingChannelGroups(actualPnl.marketingLines || []);
  const baseSpend = money(number(actualPnl.marketingSpend));
  const blendedReturn = Math.max(0, number(
    driversInput.marketingReturn,
    baseSpend > 0 ? number(actualPnl.despatchRevenue) / baseSpend : 0
  ));
  const overrides = driversInput.channelMarketingSpend && typeof driversInput.channelMarketingSpend === "object"
    ? driversInput.channelMarketingSpend
    : {};
  const returnOverrides = driversInput.channelMarketingReturn && typeof driversInput.channelMarketingReturn === "object"
    ? driversInput.channelMarketingReturn
    : {};
  const hasOverrides = Object.keys(overrides).length > 0;
  const explicitTotal = driversInput.marketingSpend == null || driversInput.marketingSpend === ""
    ? null
    : Math.max(0, number(driversInput.marketingSpend));
  const channels = groups.length ? groups : [{ channel: "Marketing", amount: baseSpend, attributedRevenue: 0, attributedRoas: 0, attributionWeight: 1 }];
  const channelScoreCapMultiplier = Math.max(0, number(driversInput.channelScoreCapMultiplier, 1.5));
  const channelScoreCap = blendedReturn > 0 && channelScoreCapMultiplier > 0
    ? blendedReturn * channelScoreCapMultiplier
    : Infinity;
  const scored = channels.map(channel => {
    const uncappedRawScore = channel.amount > 0 && channel.attributedRevenue > 0
      ? (channel.attributedRevenue * Math.max(0, number(channel.attributionWeight, 1))) / channel.amount
      : 1;
    const rawScore = Math.min(uncappedRawScore, channelScoreCap);
    return {
      ...channel,
      rawScore,
      uncappedRawScore,
      scoreCapped: rawScore < uncappedRawScore
    };
  });
  const weightedScore = scored.reduce((sum, channel) => sum + channel.amount * channel.rawScore, 0);
  const weightedSpend = scored.reduce((sum, channel) => sum + channel.amount, 0);
  const averageScore = weightedSpend > 0 && weightedScore > 0 ? weightedScore / weightedSpend : 1;
  let scenarioSpend = 0;
  let incrementalRevenue = 0;
  let weightedScenarioReturn = 0;
  const forecastChannels = scored.map(channel => {
    let spend = channel.amount;
    if (Object.prototype.hasOwnProperty.call(overrides, channel.channel)) {
      spend = Math.max(0, number(overrides[channel.channel], channel.amount));
    } else if (!hasOverrides && explicitTotal != null && baseSpend > 0) {
      spend = channel.amount * (explicitTotal / baseSpend);
    }
    const calibratedReturn = averageScore > 0 ? channel.rawScore * (blendedReturn / averageScore) : blendedReturn;
    const hasReturnOverride = Object.prototype.hasOwnProperty.call(returnOverrides, channel.channel);
    const scenarioReturn = hasReturnOverride
      ? Math.max(0, number(returnOverrides[channel.channel], calibratedReturn))
      : calibratedReturn;
    const revenueDelta = (spend - channel.amount) * scenarioReturn;
    scenarioSpend += spend;
    incrementalRevenue += revenueDelta;
    weightedScenarioReturn += spend * scenarioReturn;
    return {
      ...channel,
      scenarioSpend: money(spend),
      calibratedReturn: Math.round(calibratedReturn * 100) / 100,
      scenarioReturn: Math.round(scenarioReturn * 100) / 100,
      returnOverridden: hasReturnOverride,
      revenueDelta: money(revenueDelta)
    };
  });
  if (!channels.length && explicitTotal != null) scenarioSpend = explicitTotal;
  const spendDelta = scenarioSpend - baseSpend;
  return {
    baseSpend,
    scenarioSpend: money(scenarioSpend),
    blendedReturn: Math.round(blendedReturn * 100) / 100,
    scenarioReturn: scenarioSpend > 0 ? Math.round((weightedScenarioReturn / scenarioSpend) * 100) / 100 : 0,
    incrementalReturn: spendDelta > 0 ? Math.round((incrementalRevenue / spendDelta) * 100) / 100 : 0,
    incrementalRevenue: money(incrementalRevenue),
    channels: forecastChannels,
    method: "shopify-calibrated-platform-attribution"
  };
}

function breakEvenMarketingReturn(actualsInput, costRules = [], driversInput = {}) {
  const actuals = normalizeActuals(actualsInput);
  const days = Math.max(1, actuals.range.days);
  const targetDailySales = Math.max(0, number(
    driversInput.targetDailySales,
    actuals.despatchRevenue / days
  ));
  const baseDrivers = {
    ...driversInput,
    targetDailySales,
    marketingDrivesSales: false,
    marketingRevenueDelta: 0,
    marketingSpend: actuals.marketingSpend
  };
  const revenueStep = Math.max(100, Math.min(5000, Math.max(actuals.despatchRevenue, targetDailySales * days) * 0.01));
  const baseActuals = scenarioActuals(actuals, baseDrivers);
  const bumpedActuals = scenarioActuals(actuals, {
    ...baseDrivers,
    targetDailySales: targetDailySales + (revenueStep / days)
  });
  const basePnl = buildPnl(baseActuals, costRules, []);
  const bumpedPnl = buildPnl(bumpedActuals, costRules, []);
  const despatchDelta = number(bumpedPnl.despatchRevenue) - number(basePnl.despatchRevenue);
  const profitDelta = number(bumpedPnl.operatingProfit) - number(basePnl.operatingProfit);
  const contributionMargin = despatchDelta > 0 ? profitDelta / despatchDelta : 0;
  const requiredReturn = contributionMargin > 0 ? 1 / contributionMargin : 0;
  return {
    requiredReturn: requiredReturn > 0 ? Math.round(requiredReturn * 100) / 100 : null,
    contributionMargin: Math.round(contributionMargin * 10000) / 10000,
    contributionPerDespatch: Math.round(contributionMargin * 100) / 100,
    revenueStep: money(despatchDelta)
  };
}

function effectiveVatRate(netRevenue, shippingRevenue, tax, returnFees = 0) {
  return finance.effectiveVatRate(netRevenue, shippingRevenue, tax, returnFees);
}

function demandRevenueFromParts(grossRevenue, discounts, netRevenue, shippingRevenue, tax, returnFees = 0) {
  return finance.demandRevenueFromParts(grossRevenue, discounts, netRevenue, shippingRevenue, tax, returnFees);
}

function normalizeActuals(input = {}) {
  const range = input.range ? validateRange(input.range) : validateRange(input);
  const orders = Math.max(0, number(input.orders ?? input.orderCount));
  const units = Math.max(0, number(input.units));
  const grossUnits = Math.max(units, number(input.grossUnits, units));
  const returnedUnits = Math.max(0, number(input.returnedUnits));
  const netRevenue = money(input.netRevenue);
  const grossRevenue = money(input.grossRevenue);
  const discounts = Math.abs(money(input.discounts));
  const shippingRevenue = money(input.shippingRevenue);
  const tax = money(input.tax);
  const returnFees = money(input.returnFees);
  const despatchRevenue = money(input.despatchRevenue ?? (netRevenue + shippingRevenue + tax + returnFees));
  const demandRevenue = money(input.demandRevenue ?? demandRevenueFromParts(grossRevenue, discounts, netRevenue, shippingRevenue, tax, returnFees));
  const cogs = money(input.cogs);
  const sales = finance.salesFinancials({
    netSales: netRevenue,
    grossSales: grossRevenue,
    costOfGoods: cogs,
    grossProfit: input.grossProfit,
    salesIncludeVat: false
  });
  const grossProfit = money(sales.grossProfit);
  const operatingCosts = money(input.operatingCosts);
  const operatingProfit = money(input.operatingProfit == null ? grossProfit - operatingCosts : input.operatingProfit);
  const warnings = Array.isArray(input.warnings) ? input.warnings.map(text).filter(Boolean) : [];
  return {
    range,
    netRevenue,
    grossRevenue,
    demandRevenue,
    despatchRevenue,
    shippingRevenue,
    tax,
    discounts,
    returns: money(input.returns),
    returnFees,
    orders,
    units,
    grossUnits,
    returnedUnits,
    cogs,
    grossProfit,
    grossMargin: sales.grossMargin ?? 0,
    aov: orders > 0 ? despatchRevenue / orders : 0,
    itemsPerOrder: orders > 0 ? units / orders : 0,
    missingCostUnits: Math.max(0, number(input.missingCostUnits)),
    missingCostRevenue: money(input.missingCostRevenue),
    marketingSpend: money(input.marketingSpend),
    operatingCosts,
    operatingProfit,
    operatingMargin: netRevenue > 0 ? operatingProfit / netRevenue : 0,
    profitPerDay: range.days > 0 ? operatingProfit / range.days : 0,
    warnings
  };
}

function reportNumber(row = {}, name) {
  return number(row[name]);
}

function shopifyQlSalesActualsFromRow(row = {}, rangeInput = {}) {
  return normalizeActuals({
    range: validateRange(rangeInput),
    netRevenue: reportNumber(row, "net_sales"),
    grossRevenue: reportNumber(row, "gross_sales"),
    despatchRevenue: reportNumber(row, "total_sales"),
    shippingRevenue: reportNumber(row, "shipping_charges"),
    tax: reportNumber(row, "taxes"),
    discounts: Math.abs(reportNumber(row, "discounts")),
    returns: Math.abs(reportNumber(row, "returns") || reportNumber(row, "sales_reversals")),
    returnFees: reportNumber(row, "return_fees"),
    orders: reportNumber(row, "orders"),
    units: Math.max(0, reportNumber(row, "quantity_ordered")),
    grossUnits: Math.max(0, reportNumber(row, "quantity_ordered")),
    returnedUnits: Math.abs(reportNumber(row, "quantity_returned")),
    cogs: reportNumber(row, "cost_of_goods_sold"),
    grossProfit: reportNumber(row, "gross_profit")
  });
}

function groupLines(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.category || "Other";
    const current = groups.get(key) || { category: key, amount: 0, lines: [] };
    current.amount += number(line.amountApplied);
    current.lines.push(line);
    groups.set(key, current);
  }
  return [...groups.values()].map(group => ({ ...group, amount: money(group.amount) })).sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
}

function buildPnl(actualsInput, costRules = [], marketingEntries = []) {
  const base = normalizeActuals(actualsInput);
  const ruleLines = costRules.map(rule => calculateCostRule(rule, base, base.range)).filter(line => line.amountApplied || ruleIsActive(line, base.range));
  const marketingLines = effectiveMarketingEntries(marketingEntries).map(entry => publicMarketingEntry(entry, base.range)).filter(line => line.amountApplied > 0);
  const costRuleTotal = money(ruleLines.reduce((sum, line) => sum + number(line.amountApplied), 0));
  const fixedCostTotal = money(ruleLines
    .filter(line => line.costType === "fixed_monthly")
    .reduce((sum, line) => sum + number(line.amountApplied), 0));
  const variableCostTotal = money(ruleLines
    .filter(line => line.costType !== "fixed_monthly")
    .reduce((sum, line) => sum + number(line.amountApplied), 0));
  const orderVariableCostTotal = money(ruleLines.reduce((sum, line) => sum + number(line.orderDrivenAmount), 0));
  const revenueVariableCostTotal = money(ruleLines.reduce((sum, line) => sum + number(line.revenueDrivenAmount), 0));
  const fixedCostPerOrder = base.orders > 0 ? money(fixedCostTotal / base.orders) : 0;
  const variableCostPerOrder = base.orders > 0 ? money(variableCostTotal / base.orders) : 0;
  const orderVariableCostPerOrder = base.orders > 0 ? money(orderVariableCostTotal / base.orders) : 0;
  const marketingSpend = money(marketingLines.reduce((sum, line) => sum + number(line.amountApplied), 0));
  const operatingCosts = money(costRuleTotal + marketingSpend);
  // Preserve a source-reported gross-profit value (notably ShopifyQL) through
  // the statement build. normalizeActuals already derives net sales - COGS
  // when the source does not provide gross profit explicitly.
  const grossProfit = money(base.grossProfit);
  const contributionProfit = money(grossProfit - marketingSpend - variableCostTotal);
  const operatingProfit = money(grossProfit - operatingCosts);
  const totals = normalizeActuals({
    ...base,
    grossProfit,
    operatingCosts,
    operatingProfit
  });
  const resultBase = {
    ...totals,
    marketingSpend,
    marketingLines
  };
  return {
    ...totals,
    costRuleTotal,
    fixedCostTotal,
    fixedCostPerOrder,
    fixedCostImpact: totals.netRevenue > 0 ? fixedCostTotal / totals.netRevenue : 0,
    contributionProfit,
    contributionMargin: totals.netRevenue > 0 ? contributionProfit / totals.netRevenue : 0,
    variableCostTotal,
    variableCostPerOrder,
    orderVariableCostTotal,
    orderVariableCostPerOrder,
    revenueVariableCostTotal,
    marketingSpend,
    costLines: ruleLines,
    marketingLines,
    marketingForecast: marketingForecastModel(resultBase),
    costGroups: groupLines([
      ...ruleLines,
      ...marketingLines.map(line => ({ ...line, name: line.channel, category: "Marketing" }))
    ]),
    warnings: [
      ...base.warnings,
      base.missingCostUnits > 0 ? `${Math.round(base.missingCostUnits).toLocaleString("en-GB")} sold units are missing Shopify unit cost.` : "",
      base.missingCostRevenue > 0 ? `${money(base.missingCostRevenue).toLocaleString("en-GB", { style: "currency", currency: "GBP" })} revenue has no COGS estimate.` : ""
    ].filter(Boolean)
  };
}

function hasChannelMarketingOverrides(driversInput = {}) {
  return driversInput.channelMarketingSpend
    && typeof driversInput.channelMarketingSpend === "object"
    && Object.keys(driversInput.channelMarketingSpend).length > 0;
}

function scenarioMarketingEntriesForForecast(actualPnl, marketingEntries = [], driversInput = {}, marketingForecast = marketingForecastModel(actualPnl, driversInput)) {
  if (hasChannelMarketingOverrides(driversInput)) {
    return marketingForecast.channels.map(channel => ({
      id: `scenario-marketing-${channel.channel}`,
      channel: channel.channel,
      startDate: actualPnl.range.startDate,
      endDate: actualPnl.range.endDate,
      amount: channel.scenarioSpend
    }));
  }
  return driversInput.marketingSpend == null || driversInput.marketingSpend === ""
    ? marketingEntries
    : [{
      id: "scenario-marketing",
      channel: "Scenario marketing",
      startDate: actualPnl.range.startDate,
      endDate: actualPnl.range.endDate,
      amount: number(driversInput.marketingSpend)
    }];
}

function scenarioBaseDrivers(actuals) {
  const base = normalizeActuals(actuals);
  const marketingSpend = number(base.marketingSpend);
  return {
    targetDailySales: base.range.days > 0 ? base.despatchRevenue / base.range.days : 0,
    aovDelta: 0,
    itemsPerOrder: base.itemsPerOrder || 1,
    grossMarginOverride: "",
    marketingSpend: null,
    marketingDrivesSales: false,
    marketingReturn: marketingSpend > 0 ? base.despatchRevenue / marketingSpend : 0
  };
}

function scenarioActuals(actualsInput, driversInput = {}) {
  const actuals = normalizeActuals(actualsInput);
  const drivers = { ...scenarioBaseDrivers(actuals), ...driversInput };
  const baseDespatch = actuals.despatchRevenue || actuals.netRevenue || 0;
  const baseMarketing = number(actuals.marketingSpend);
  const scenarioMarketing = drivers.marketingSpend == null || drivers.marketingSpend === ""
    ? baseMarketing
    : Math.max(0, number(drivers.marketingSpend));
  const targetDailySales = Math.max(0, number(drivers.targetDailySales, baseDespatch / Math.max(actuals.range.days, 1)));
  const targetDespatchRevenue = money(targetDailySales * actuals.range.days);
  const marketingRevenueDelta = Number.isFinite(Number(drivers.marketingRevenueDelta))
    ? number(drivers.marketingRevenueDelta)
    : (scenarioMarketing - baseMarketing) * Math.max(0, number(drivers.marketingReturn));
  const despatchRevenue = drivers.marketingDrivesSales
    ? money(Math.max(0, drivers.targetDailySalesIncludesMarketing ? targetDespatchRevenue : targetDespatchRevenue + marketingRevenueDelta))
    : targetDespatchRevenue;
  const netRatio = baseDespatch > 0 ? actuals.netRevenue / baseDespatch : 1;
  const grossRatio = baseDespatch > 0 ? actuals.grossRevenue / baseDespatch : netRatio;
  const demandRatio = baseDespatch > 0 ? actuals.demandRevenue / baseDespatch : grossRatio;
  const discountRatio = baseDespatch > 0 ? actuals.discounts / baseDespatch : 0;
  const returnsRatio = baseDespatch > 0 ? actuals.returns / baseDespatch : 0;
  const shippingRatio = baseDespatch > 0 ? actuals.shippingRevenue / baseDespatch : 0;
  const taxRatio = baseDespatch > 0 ? actuals.tax / baseDespatch : 0;
  const returnFeesRatio = baseDespatch > 0 ? actuals.returnFees / baseDespatch : 0;
  const netRevenue = money(despatchRevenue * netRatio);
  const aov = Math.max(0.01, actuals.aov + number(drivers.aovDelta));
  const orders = despatchRevenue > 0 ? despatchRevenue / aov : 0;
  const itemsPerOrder = Math.max(0, number(drivers.itemsPerOrder, actuals.itemsPerOrder || 1));
  const units = orders * itemsPerOrder;
  const grossMargin = drivers.grossMarginOverride === "" || drivers.grossMarginOverride == null
    ? actuals.grossMargin
    : rate(drivers.grossMarginOverride);
  const grossProfit = money(netRevenue * grossMargin);
  const cogs = money(netRevenue - grossProfit);
  return normalizeActuals({
    range: actuals.range,
    netRevenue,
    grossRevenue: money(despatchRevenue * grossRatio),
    demandRevenue: money(despatchRevenue * demandRatio),
    despatchRevenue,
    discounts: money(despatchRevenue * discountRatio),
    returns: money(despatchRevenue * returnsRatio),
    shippingRevenue: money(despatchRevenue * shippingRatio),
    tax: money(despatchRevenue * taxRatio),
    returnFees: money(despatchRevenue * returnFeesRatio),
    orders,
    units,
    cogs,
    grossProfit,
    missingCostUnits: actuals.missingCostUnits,
    missingCostRevenue: actuals.missingCostRevenue
  });
}

function leveragePoint(pnl, days) {
  return {
    range: pnl.range,
    dailyDespatch: days > 0 ? money(pnl.despatchRevenue / days) : 0,
    despatchRevenue: pnl.despatchRevenue,
    netRevenue: pnl.netRevenue,
    orders: pnl.orders,
    fixedCostTotal: pnl.fixedCostTotal,
    fixedCostPerOrder: pnl.fixedCostPerOrder,
    fixedCostImpact: Math.round(number(pnl.fixedCostImpact) * 10000) / 10000,
    contributionProfit: pnl.contributionProfit,
    contributionMargin: Math.round(number(pnl.contributionMargin) * 10000) / 10000,
    operatingProfit: pnl.operatingProfit,
    operatingMargin: pnl.operatingMargin,
    profitPerDay: pnl.profitPerDay
  };
}

function findDailyThreshold(buildAtDaily, predicate, startDaily) {
  const zero = buildAtDaily(0);
  if (predicate(zero)) return zero;
  let high = Math.max(100, number(startDaily, 0));
  let highPoint = buildAtDaily(high);
  let attempts = 0;
  while (!predicate(highPoint) && attempts < 18) {
    high *= 1.5;
    highPoint = buildAtDaily(high);
    attempts += 1;
  }
  if (!predicate(highPoint)) return null;
  let low = 0;
  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) / 2;
    const point = buildAtDaily(mid);
    if (predicate(point)) {
      high = mid;
      highPoint = point;
    } else {
      low = mid;
    }
  }
  return highPoint;
}

function operatingLeverage(actualsInput, costRules = [], marketingEntries = [], driversInput = {}) {
  const actualPnl = actualsInput && Array.isArray(actualsInput.costLines) && Array.isArray(actualsInput.marketingLines)
    ? actualsInput
    : buildPnl(actualsInput, costRules, marketingEntries);
  const days = Math.max(1, actualPnl.range.days);
  const actualDaily = actualPnl.despatchRevenue / days;
  const selectedDaily = Math.max(0, number(driversInput.targetDailySales, actualDaily));
  const fixedDragThreshold = Math.max(0.001, Math.min(0.5, rate(driversInput.fixedCostImpactThreshold || 0.05)));
  const marketingForecast = marketingForecastModel(actualPnl, driversInput);
  const leverageDrivers = {
    ...driversInput,
    marketingSpend: marketingForecast.scenarioSpend,
    marketingReturn: marketingForecast.blendedReturn,
    marketingRevenueDelta: 0,
    marketingDrivesSales: false,
    targetDailySalesIncludesMarketing: true
  };
  const scenarioMarketingEntries = scenarioMarketingEntriesForForecast(actualPnl, marketingEntries, {
    ...driversInput,
    marketingSpend: marketingForecast.scenarioSpend
  }, marketingForecast);
  const buildAtDaily = dailyDespatch => buildPnl(
    scenarioActuals(actualPnl, {
      ...leverageDrivers,
      targetDailySales: Math.max(0, number(dailyDespatch))
    }),
    costRules,
    scenarioMarketingEntries
  );
  const selected = buildAtDaily(selectedDaily);
  const breakEven = findDailyThreshold(buildAtDaily, point => number(point.operatingProfit) >= 0, selectedDaily);
  const lowFixedDrag = number(selected.fixedCostTotal) <= 0
    ? buildAtDaily(0)
    : findDailyThreshold(buildAtDaily, point => number(point.netRevenue) > 0 && number(point.fixedCostImpact) <= fixedDragThreshold, selectedDaily);
  const dailyValues = new Set([actualDaily, selectedDaily]);
  for (const multiplier of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    dailyValues.add(selectedDaily * multiplier);
  }
  if (breakEven) dailyValues.add(breakEven.despatchRevenue / days);
  if (lowFixedDrag) dailyValues.add(lowFixedDrag.despatchRevenue / days);
  const points = [...dailyValues]
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
    .map(value => leveragePoint(buildAtDaily(value), days));
  return {
    fixedDragThreshold,
    selected: leveragePoint(selected, days),
    breakEven: breakEven ? leveragePoint(breakEven, days) : null,
    lowFixedDrag: lowFixedDrag ? leveragePoint(lowFixedDrag, days) : null,
    points
  };
}

function buildScenario(actualsInput, costRules = [], marketingEntries = [], driversInput = {}) {
  const actualPnl = buildPnl(actualsInput, costRules, marketingEntries);
  const marketingForecast = marketingForecastModel(actualPnl, driversInput);
  const breakEvenMarketing = breakEvenMarketingReturn(actualPnl, costRules, driversInput);
  const scenarioDrivers = {
    ...driversInput,
    marketingSpend: marketingForecast.scenarioSpend,
    marketingReturn: marketingForecast.blendedReturn,
    marketingRevenueDelta: marketingForecast.incrementalRevenue
  };
  const simulatedActuals = scenarioActuals(actualPnl, scenarioDrivers);
  const scenarioMarketingEntries = scenarioMarketingEntriesForForecast(actualPnl, marketingEntries, driversInput, marketingForecast);
  const scenario = buildPnl(simulatedActuals, costRules, scenarioMarketingEntries);
  const keys = ["despatchRevenue", "demandRevenue", "grossRevenue", "netRevenue", "discounts", "returns", "shippingRevenue", "orders", "units", "aov", "cogs", "grossProfit", "grossMargin", "fixedCostTotal", "fixedCostPerOrder", "fixedCostImpact", "contributionProfit", "contributionMargin", "variableCostTotal", "variableCostPerOrder", "orderVariableCostTotal", "orderVariableCostPerOrder", "revenueVariableCostTotal", "marketingSpend", "operatingCosts", "operatingProfit", "operatingMargin", "profitPerDay"];
  const delta = Object.fromEntries(keys.map(key => [key, money(number(scenario[key]) - number(actualPnl[key]))]));
  delta.grossMargin = scenario.grossMargin - actualPnl.grossMargin;
  delta.fixedCostImpact = scenario.fixedCostImpact - actualPnl.fixedCostImpact;
  delta.contributionMargin = scenario.contributionMargin - actualPnl.contributionMargin;
  delta.operatingMargin = scenario.operatingMargin - actualPnl.operatingMargin;
  const leverageDrivers = {
    ...driversInput,
    targetDailySales: scenario.range.days > 0 ? scenario.despatchRevenue / scenario.range.days : 0,
    marketingSpend: scenarioDrivers.marketingSpend,
    marketingReturn: marketingForecast.blendedReturn,
    marketingRevenueDelta: 0,
    marketingDrivesSales: false,
    targetDailySalesIncludesMarketing: true
  };
  return {
    actual: actualPnl,
    scenario,
    delta,
    marketingForecast,
    breakEvenMarketing,
    leverage: operatingLeverage(actualPnl, costRules, marketingEntries, leverageDrivers),
    drivers: {
      targetDailySales: money(number(driversInput.targetDailySales, actualPnl.despatchRevenue / Math.max(actualPnl.range.days, 1))),
      aovDelta: money(driversInput.aovDelta),
      itemsPerOrder: number(driversInput.itemsPerOrder, actualPnl.itemsPerOrder),
      grossMarginOverride: driversInput.grossMarginOverride ?? "",
      marketingSpend: scenarioDrivers.marketingSpend ?? "",
      marketingDrivesSales: Boolean(driversInput.marketingDrivesSales),
      targetDailySalesIncludesMarketing: Boolean(driversInput.targetDailySalesIncludesMarketing),
      marketingReturn: marketingForecast.blendedReturn,
      channelMarketingSpend: driversInput.channelMarketingSpend || {},
      channelMarketingReturn: driversInput.channelMarketingReturn || {}
    }
  };
}

function sensitivityTables(actualsInput, costRules = [], marketingEntries = [], driversInput = {}) {
  const actualPnl = buildPnl(actualsInput, costRules, marketingEntries);
  const baseDaily = actualPnl.range.days > 0 ? actualPnl.despatchRevenue / actualPnl.range.days : 0;
  const baseMarketing = actualPnl.marketingSpend;
  const selectedDaily = driversInput.targetDailySales == null || driversInput.targetDailySales === "" ? baseDaily : number(driversInput.targetDailySales, baseDaily);
  const selectedAovDelta = number(driversInput.aovDelta);
  const selectedMarketing = driversInput.marketingSpend == null || driversInput.marketingSpend === "" ? baseMarketing : number(driversInput.marketingSpend, baseMarketing);
  const dailySalesSteps = [-1000, 0, 1000, 2000].map(offset => Math.max(0, selectedDaily + offset));
  const aovSteps = [-5, 0, 5, 10].map(offset => selectedAovDelta + offset);
  const marketingSteps = [-1000, 0, 1000, 2500].map(offset => Math.max(0, selectedMarketing + offset));
  return {
    dailySales: dailySalesSteps.map(value => buildScenario(actualPnl, costRules, marketingEntries, { ...driversInput, targetDailySales: value }).scenario),
    aov: aovSteps.map(value => buildScenario(actualPnl, costRules, marketingEntries, { ...driversInput, aovDelta: value }).scenario),
    marketing: marketingSteps.map(value => buildScenario(actualPnl, costRules, marketingEntries, { ...driversInput, marketingSpend: value }).scenario)
  };
}

module.exports = {
  COST_TYPES,
  buildPnl,
  buildScenario,
  calculateCostRule,
  daysInclusive,
  effectiveMarketingEntries,
  marketingEntryAmount,
  money,
  normalizeActuals,
  operatingLeverage,
  publicMarketingEntry,
  publicRule,
  rate,
  scenarioActuals,
  shopifyQlSalesActualsFromRow,
  breakEvenMarketingReturn,
  marketingForecastModel,
  sensitivityTables,
  validateRange
};
