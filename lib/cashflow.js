"use strict";

const pnl = require("./pnl");
const finance = require("./commerce-finance");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function number(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function money(value) {
  return Math.round(number(value) * 100) / 100;
}

function parseDate(value) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? date : null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value.getTime()) : parseDate(value);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return isoDate(date);
}

function addBusinessDays(value, days) {
  const date = parseDate(value);
  if (!date) return "";
  let remaining = Math.max(0, Math.trunc(number(days)));
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return isoDate(date);
}

function addMonthsClamped(value, months) {
  const date = parseDate(value);
  if (!date) return "";
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Math.trunc(number(months)), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return isoDate(target);
}

function previousWeekday(value) {
  const date = parseDate(value);
  if (!date) return "";
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  else if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() - 2);
  return isoDate(date);
}

function vatPaymentDate(periodEnd) {
  const date = parseDate(periodEnd);
  if (!date) return "";
  const nextMonthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0));
  return previousWeekday(addDays(isoDate(nextMonthEnd), 7));
}

function quarterlyVatPeriods(anchorValue, horizonStartValue, horizonEndValue) {
  const anchor = parseDate(anchorValue);
  const horizonStart = parseDate(horizonStartValue);
  const horizonEnd = parseDate(horizonEndValue);
  if (!anchor || !horizonStart || !horizonEnd || horizonStart > horizonEnd) return [];
  const anchorIsMonthEnd = anchor.getUTCDate() === new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  const quarterEndAt = offset => {
    const candidate = addMonthsClamped(anchorValue, offset * 3);
    if (!anchorIsMonthEnd) return candidate;
    const date = parseDate(candidate);
    return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
  };
  const periods = [];
  for (let offset = -200; offset <= 200; offset += 1) {
    const periodEnd = quarterEndAt(offset);
    const paymentDate = vatPaymentDate(periodEnd);
    if (paymentDate < horizonStartValue || paymentDate > horizonEndValue) continue;
    const previousPeriodEnd = quarterEndAt(offset - 1);
    periods.push({
      periodStart: addDays(previousPeriodEnd, 1),
      periodEnd,
      paymentDate
    });
  }
  return periods.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
}

function mondayOf(value) {
  const date = parseDate(value);
  if (!date) return "";
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return isoDate(date);
}

function publicTiming(value = {}, fallback = "weekly") {
  const setting = value && typeof value === "object" ? value : {};
  const configured = setting.paymentTiming === "month_end" ? "scheduled" : setting.paymentTiming;
  return {
    enabled: setting.enabled !== false,
    paymentTiming: configured === "scheduled" ? "scheduled" : configured === "weekly" ? "weekly" : fallback,
    paymentDate: parseDate(setting.paymentDate) ? setting.paymentDate : ""
  };
}

function calendarMonthRange(value) {
  const date = parseDate(value);
  if (!date) return null;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function previousCalendarMonthRange(value) {
  const date = parseDate(value);
  if (!date) return null;
  const previousMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return calendarMonthRange(isoDate(previousMonth));
}

function monthlyPaymentDates(anchorValue, startValue, endValue) {
  const anchor = parseDate(anchorValue);
  const start = parseDate(startValue);
  const end = parseDate(endValue);
  if (!anchor || !start || !end || start > end) return [];
  const anchorDay = anchor.getUTCDate();
  let year = anchor.getUTCFullYear();
  let month = anchor.getUTCMonth();
  if (start > anchor) {
    year = start.getUTCFullYear();
    month = start.getUTCMonth();
  }
  const dates = [];
  for (let guard = 0; guard < 1200; guard += 1) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const candidate = new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)));
    if (candidate > end) break;
    if (candidate >= anchor && candidate >= start) dates.push(isoDate(candidate));
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return dates;
}

function buildWeeks(startDateInput, countInput = 13) {
  const startDate = mondayOf(startDateInput);
  if (!startDate) throw new Error("Choose a valid cashflow start date.");
  const count = Math.max(1, Math.min(52, Math.trunc(number(countInput, 13))));
  return Array.from({ length: count }, (_, index) => {
    const weekStart = addDays(startDate, index * 7);
    return {
      index,
      startDate: weekStart,
      endDate: addDays(weekStart, 6)
    };
  });
}

function dayRange(startDate, endDate) {
  const values = [];
  for (let cursor = startDate; cursor && cursor <= endDate; cursor = addDays(cursor, 1)) values.push(cursor);
  return values;
}

function publicBudget(row = {}) {
  return {
    id: text(row.id),
    weekStart: mondayOf(row.weekStart || row.week_start),
    amount: money(Math.max(0, number(row.amount))),
    marketingAmount: money(Math.max(0, number(row.marketingAmount ?? row.marketing_amount))),
    notes: text(row.notes)
  };
}

function publicMovement(row = {}) {
  const direction = text(row.direction).toLowerCase() === "inflow" ? "inflow" : "outflow";
  return {
    id: text(row.id),
    date: text(row.date || row.movementDate || row.paymentDate),
    direction,
    category: text(row.category) || "Other",
    name: text(row.name || row.label) || "Cash movement",
    amount: money(Math.max(0, number(row.amount))),
    source: text(row.source) || "manual",
    status: text(row.status),
    orderId: text(row.orderId),
    orderNumber: text(row.orderNumber),
    invoiceId: text(row.invoiceId),
    invoiceNumber: text(row.invoiceNumber),
    notes: text(row.notes),
    estimated: Boolean(row.estimated)
  };
}

function normalizedActual(row = {}) {
  const rawTax = row.tax ?? row.taxes;
  return {
    date: text(row.date || row.day),
    despatch: money(number(row.despatch ?? row.despatchRevenue ?? row.totalSales)),
    orders: Math.max(0, number(row.orders ?? row.orderCount)),
    units: Math.max(0, number(row.units ?? row.quantityOrdered)),
    tax: rawTax == null || rawTax === "" || !Number.isFinite(Number(rawTax)) ? null : money(Number(rawTax))
  };
}

function allocateDespatchDays({ weeks, budgets = [], dailyActuals = [], asOfDate, forecastAov = 0, forecastItemsPerOrder = 0, lookbackStart = "" }) {
  const budgetMap = new Map(budgets.map(publicBudget).filter(row => row.weekStart).map(row => [row.weekStart, row]));
  const actualMap = new Map(dailyActuals.map(normalizedActual).filter(row => parseDate(row.date)).map(row => [row.date, row]));
  const actualCutoff = addDays(asOfDate, -1);
  const days = [];
  const firstWeekStart = weeks[0].startDate;
  const normalizedLookbackStart = parseDate(lookbackStart) && lookbackStart < firstWeekStart ? lookbackStart : addDays(firstWeekStart, -10);

  for (const date of dayRange(normalizedLookbackStart, addDays(firstWeekStart, -1))) {
    const actual = actualMap.get(date);
    if (actual) days.push({ ...actual, source: "actual" });
  }

  for (const week of weeks) {
    const weekDays = dayRange(week.startDate, week.endDate);
    const actualDays = weekDays.filter(date => date <= actualCutoff);
    const futureDays = weekDays.filter(date => date > actualCutoff);
    const actualRows = actualDays.map(date => actualMap.get(date) || { date, despatch: 0, orders: 0, units: 0 });
    days.push(...actualRows.map(row => ({ ...row, source: "actual" })));

    if (!futureDays.length) continue;
    const budget = budgetMap.get(week.startDate)?.amount || 0;
    const actualDespatch = actualRows.reduce((sum, row) => sum + number(row.despatch), 0);
    const remainingBudget = Math.max(0, budget - actualDespatch);
    const dailyAmount = futureDays.length ? remainingBudget / futureDays.length : 0;
    let allocated = 0;
    for (const [index, date] of futureDays.entries()) {
      const amount = index === futureDays.length - 1 ? money(remainingBudget - allocated) : money(dailyAmount);
      allocated += amount;
      const dailyOrders = forecastAov > 0 ? amount / forecastAov : 0;
      days.push({
        date,
        despatch: amount,
        orders: dailyOrders,
        units: dailyOrders * Math.max(0, forecastItemsPerOrder),
        source: "forecast"
      });
    }
  }
  return { days, budgetMap, actualCutoff };
}

function weekForDate(weeks, value) {
  return weeks.find(week => value >= week.startDate && value <= week.endDate) || null;
}

function sumBy(rows, selector) {
  return rows.reduce((sum, row) => sum + number(selector(row)), 0);
}

function buildCashflow(input = {}) {
  const weeks = buildWeeks(input.startDate, input.weeks);
  const asOfDate = parseDate(input.asOfDate) ? input.asOfDate : isoDate(new Date());
  const receiptLagBusinessDays = Math.max(0, Math.min(15, Math.trunc(number(input.receiptLagBusinessDays, 3))));
  const openingBalance = money(number(input.openingBalance));
  const forecastAov = Math.max(0, number(input.forecastAov));
  const forecastItemsPerOrder = Math.max(0, number(input.forecastItemsPerOrder));
  const costRules = input.costRules || [];
  const costTiming = input.costTiming && typeof input.costTiming === "object" ? input.costTiming : {};
  const ruleTiming = rule => publicTiming(costTiming[text(rule.id)], "weekly");
  const costForecasts = Array.isArray(input.costForecasts) ? input.costForecasts : [];
  const vatInput = input.vatSettings && typeof input.vatSettings === "object" ? input.vatSettings : {};
  const vatSettings = {
    enabled: Boolean(vatInput.enabled),
    periodEndAnchor: parseDate(vatInput.periodEndAnchor) ? vatInput.periodEndAnchor : "",
    inputRecoveryPercent: Math.max(0, Math.min(100, number(vatInput.inputRecoveryPercent)))
  };
  const vatPeriods = vatSettings.enabled && vatSettings.periodEndAnchor
    ? quarterlyVatPeriods(vatSettings.periodEndAnchor, weeks[0].startDate, weeks[weeks.length - 1].endDate)
    : [];
  const vatLookbackStart = vatPeriods.map(row => row.periodStart).sort()[0] || weeks[0].startDate;
  const receiptLookbackStart = addDays(weeks[0].startDate, -(receiptLagBusinessDays * 2 + 7));
  const datedRuleLookbackStart = costRules.map(ruleTiming).filter(row => row.enabled && row.paymentTiming === "scheduled" && row.paymentDate).flatMap(row => monthlyPaymentDates(row.paymentDate, weeks[0].startDate, weeks[weeks.length - 1].endDate).map(paymentDate => previousCalendarMonthRange(paymentDate)?.startDate)).filter(Boolean).sort()[0] || weeks[0].startDate;
  const serviceLookbackStart = costForecasts.filter(row => row.calculationType === "pnl_rule" && parseDate(row.serviceStartDate)).map(row => row.serviceStartDate).sort()[0] || weeks[0].startDate;
  const operatingLookbackStart = datedRuleLookbackStart < serviceLookbackStart ? datedRuleLookbackStart : serviceLookbackStart;
  const lookbackStart = [receiptLookbackStart, operatingLookbackStart, vatLookbackStart].sort()[0];
  const allocation = allocateDespatchDays({
    weeks,
    budgets: input.budgets,
    dailyActuals: input.dailyActuals,
    asOfDate,
    forecastAov,
    forecastItemsPerOrder,
    lookbackStart
  });

  const weekly = weeks.map(week => ({
    ...week,
    openingCash: 0,
    closingCash: 0,
    netCash: 0,
    budget: allocation.budgetMap.get(week.startDate)?.amount || 0,
    marketingBudget: allocation.budgetMap.get(week.startDate)?.marketingAmount || 0,
    despatchActual: 0,
    despatchForecast: 0,
    receiptsActual: 0,
    receiptsForecast: 0,
    otherInflows: 0,
    supplierPayments: 0,
    marketingSpend: 0,
    variableCosts: 0,
    fixedCosts: 0,
    vatPayments: 0,
    otherOutflows: 0,
    movements: []
  }));
  const weeklyMap = new Map(weekly.map(week => [week.startDate, week]));

  for (const day of allocation.days) {
    const salesWeek = weekForDate(weeks, day.date);
    if (salesWeek) {
      const row = weeklyMap.get(salesWeek.startDate);
      if (day.source === "actual") row.despatchActual += number(day.despatch);
      else row.despatchForecast += number(day.despatch);
    }
    if (!day.despatch) continue;
    const receiptDate = addBusinessDays(day.date, receiptLagBusinessDays);
    const receiptWeek = weekForDate(weeks, receiptDate);
    if (!receiptWeek) continue;
    const row = weeklyMap.get(receiptWeek.startDate);
    const movement = publicMovement({
      id: `receipt:${day.date}`,
      date: receiptDate,
      direction: "inflow",
      category: "Shopify receipts",
      name: `${day.source === "actual" ? "Actual" : "Budget"} Despatch from ${day.date}`,
      amount: day.despatch,
      source: day.source,
      estimated: true,
      notes: `${receiptLagBusinessDays} business-day receipt estimate`
    });
    row.movements.push(movement);
    if (day.source === "actual") row.receiptsActual += movement.amount;
    else row.receiptsForecast += movement.amount;
  }

  const baseForRange = range => {
    const rangeDays = allocation.days.filter(day => day.date >= range.startDate && day.date <= range.endDate);
    const despatchRevenue = sumBy(rangeDays, day => day.despatch);
    return {
      range,
      despatchRevenue,
      netRevenue: finance.excludingVat(despatchRevenue, { includesVat: true }),
      orders: sumBy(rangeDays, day => day.orders),
      units: sumBy(rangeDays, day => day.units)
    };
  };
  const addOperatingMovement = ({ id, paymentDate, category, name, amount, source = "pnl", notes = "" }) => {
    const paymentWeek = weekForDate(weeks, paymentDate);
    if (!paymentWeek || amount <= 0) return;
    const row = weeklyMap.get(paymentWeek.startDate);
    const movement = publicMovement({ id, date: paymentDate, direction: "outflow", category, name, amount, source, estimated: true, notes });
    row.movements.push(movement);
    if (category === "Marketing") row.marketingSpend += movement.amount;
    else if (category === "Fixed operating costs") row.fixedCosts += movement.amount;
    else if (category === "Variable operating costs") row.variableCosts += movement.amount;
    else row.otherOutflows += movement.amount;
  };

  for (const row of weekly) {
    if (row.marketingBudget <= 0) continue;
    addOperatingMovement({
      id: `marketing-budget:${row.startDate}`,
      paymentDate: row.endDate,
      category: "Marketing",
      name: "Meta + PPC budget",
      amount: row.marketingBudget,
      source: "cashflow_budget",
      notes: "Weekly combined Meta and PPC budget"
    });
  }

  for (const row of weekly) {
    const base = baseForRange({ startDate: row.startDate, endDate: row.endDate });
    for (const rule of costRules) {
      const timing = ruleTiming(rule);
      if (!timing.enabled || timing.paymentTiming !== "weekly") continue;
      const line = pnl.calculateCostRule(rule, base, base.range);
      if (line.amountApplied <= 0) continue;
      const fixed = line.costType === "fixed_monthly";
      addOperatingMovement({
        id: `cost:${line.id || line.name}:${row.startDate}`,
        paymentDate: row.endDate,
        category: fixed ? "Fixed operating costs" : "Variable operating costs",
        name: line.name,
        amount: line.amountApplied,
        notes: `${line.formula}; paid in incurred week`
      });
    }
  }

  for (const rule of costRules) {
    const timing = ruleTiming(rule);
    if (!timing.enabled || timing.paymentTiming !== "scheduled" || !timing.paymentDate) continue;
    for (const paymentDate of monthlyPaymentDates(timing.paymentDate, weeks[0].startDate, weeks[weeks.length - 1].endDate)) {
      const range = previousCalendarMonthRange(paymentDate);
      if (!range) continue;
      const line = pnl.calculateCostRule(rule, baseForRange(range), range);
      if (line.amountApplied <= 0) continue;
      const fixed = line.costType === "fixed_monthly";
      addOperatingMovement({
        id: `cost:${line.id || line.name}:${paymentDate}`,
        paymentDate,
        category: fixed ? "Fixed operating costs" : "Variable operating costs",
        name: line.name,
        amount: line.amountApplied,
        notes: `${line.formula}; ${range.startDate} to ${range.endDate}; paid monthly in arrears from ${timing.paymentDate}`
      });
    }
  }

  const ruleMap = new Map(costRules.map(rule => [text(rule.id), rule]));
  const costCategory = costClass => ({
    marketing: "Marketing",
    variable: "Variable operating costs",
    fixed: "Fixed operating costs",
    other: "Other operating costs"
  })[costClass] || "Other operating costs";
  const resolvedCostForecasts = [];
  for (const forecast of costForecasts) {
    const calculationType = forecast.calculationType === "pnl_rule" ? "pnl_rule" : "fixed";
    const rule = calculationType === "pnl_rule" ? ruleMap.get(text(forecast.pnlRuleId)) : null;
    let amount = calculationType === "fixed" ? money(Math.max(0, number(forecast.amount))) : 0;
    let formula = "Known or estimated cashflow amount";
    if (rule && parseDate(forecast.serviceStartDate) && parseDate(forecast.serviceEndDate)) {
      const range = { startDate: forecast.serviceStartDate, endDate: forecast.serviceEndDate };
      const line = pnl.calculateCostRule(rule, baseForRange(range), range);
      amount = line.amountApplied;
      formula = line.formula;
    }
    const costClass = ["marketing", "variable", "fixed", "other"].includes(forecast.costClass) ? forecast.costClass : "other";
    const notes = [forecast.reference, calculationType === "pnl_rule" ? `${forecast.serviceStartDate} to ${forecast.serviceEndDate}; ${formula}` : formula, forecast.notes].filter(Boolean).join("; ");
    addOperatingMovement({
      id: `cost-forecast:${forecast.id}`,
      paymentDate: forecast.paymentDate || forecast.dueDate,
      category: costCategory(costClass),
      name: forecast.name,
      amount,
      source: "cashflow_forecast",
      notes
    });
    resolvedCostForecasts.push({
      ...forecast,
      pnlRuleName: rule?.name || "",
      calculatedAmount: money(amount),
      formula,
      includedInHorizon: Boolean(weekForDate(weeks, forecast.paymentDate || forecast.dueDate) && amount > 0)
    });
  }

  for (const movementInput of [...(input.supplierMovements || []), ...(input.manualMovements || [])]) {
    const movement = publicMovement(movementInput);
    if (!parseDate(movement.date) || movement.amount <= 0) continue;
    const movementWeek = weekForDate(weeks, movement.date);
    if (!movementWeek) continue;
    const row = weeklyMap.get(movementWeek.startDate);
    row.movements.push(movement);
    if (movement.direction === "inflow") row.otherInflows += movement.amount;
    else if (movement.category === "Supplier payments") row.supplierPayments += movement.amount;
    else row.otherOutflows += movement.amount;
  }

  const vatOverrideMap = new Map((Array.isArray(input.vatOverrides) ? input.vatOverrides : [])
    .filter(row => parseDate(row.periodEnd) && Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0)
    .map(row => [row.periodEnd, { ...row, amount: money(Number(row.amount)) }]));
  const vatWarnings = [];
  let fallbackActualTaxDays = 0;
  const resolvedVatPeriods = vatPeriods.map(period => {
    const periodDays = allocation.days.filter(day => day.date >= period.periodStart && day.date <= period.periodEnd);
    let actualOutputVat = 0;
    let forecastOutputVat = 0;
    for (const day of periodDays) {
      if (day.source === "forecast") {
        forecastOutputVat += number(day.despatch) - finance.excludingVat(day.despatch, { includesVat: true });
      } else if (day.tax != null) {
        actualOutputVat += number(day.tax);
      } else if (day.despatch) {
        actualOutputVat += number(day.despatch) - finance.excludingVat(day.despatch, { includesVat: true });
        fallbackActualTaxDays += 1;
      }
    }
    actualOutputVat = money(actualOutputVat);
    forecastOutputVat = money(forecastOutputVat);
    const outputVat = money(Math.max(0, actualOutputVat + forecastOutputVat));
    const calculatedAmount = money(outputVat * (1 - vatSettings.inputRecoveryPercent / 100));
    const override = vatOverrideMap.get(period.periodEnd) || null;
    const paymentAmount = override ? override.amount : calculatedAmount;
    const paymentWeek = weekForDate(weeks, period.paymentDate);
    if (paymentWeek && paymentAmount > 0) {
      const row = weeklyMap.get(paymentWeek.startDate);
      const movement = publicMovement({
        id: `vat:${period.periodEnd}`,
        date: period.paymentDate,
        direction: "outflow",
        category: "VAT payments",
        name: `VAT return to ${period.periodEnd}`,
        amount: paymentAmount,
        source: override ? "vat_override" : "vat_forecast",
        estimated: !override,
        notes: override
          ? `Saved override; calculated estimate ${money(calculatedAmount)}${override.notes ? `; ${override.notes}` : ""}`
          : `Output VAT less ${vatSettings.inputRecoveryPercent}% expected input-VAT recovery`
      });
      row.movements.push(movement);
      row.vatPayments += movement.amount;
    }
    return {
      ...period,
      actualOutputVat,
      forecastOutputVat,
      outputVat,
      inputRecoveryPercent: vatSettings.inputRecoveryPercent,
      estimatedInputVat: money(outputVat * vatSettings.inputRecoveryPercent / 100),
      calculatedAmount,
      override: override ? {
        amount: override.amount,
        notes: text(override.notes),
        createdBy: text(override.createdBy),
        updatedAt: text(override.updatedAt)
      } : null,
      paymentAmount,
      overridden: Boolean(override)
    };
  });
  if (fallbackActualTaxDays) {
    vatWarnings.push(`${fallbackActualTaxDays} completed Despatch day${fallbackActualTaxDays === 1 ? "" : "s"} had no Shopify tax value, so VAT was estimated at the standard 20% rate.`);
  }

  let runningCash = openingBalance;
  for (const row of weekly) {
    for (const key of ["despatchActual", "despatchForecast", "receiptsActual", "receiptsForecast", "otherInflows", "supplierPayments", "marketingSpend", "variableCosts", "fixedCosts", "vatPayments", "otherOutflows"]) row[key] = money(row[key]);
    row.openingCash = money(runningCash);
    const inflows = row.receiptsActual + row.receiptsForecast + row.otherInflows;
    const outflows = row.supplierPayments + row.marketingSpend + row.variableCosts + row.fixedCosts + row.vatPayments + row.otherOutflows;
    row.netCash = money(inflows - outflows);
    row.closingCash = money(row.openingCash + row.netCash);
    row.despatchPlan = money(row.despatchActual + row.despatchForecast);
    row.budgetVariance = money(row.despatchPlan - row.budget);
    row.movements.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    runningCash = row.closingCash;
  }

  const total = key => money(sumBy(weekly, row => row[key]));
  const lowWeek = weekly.reduce((lowest, row) => !lowest || row.closingCash < lowest.closingCash ? row : lowest, null);
  return {
    range: { startDate: weeks[0].startDate, endDate: weeks[weeks.length - 1].endDate, weeks: weeks.length },
    asOfDate,
    receiptLagBusinessDays,
    openingBalance,
    forecastAov: money(forecastAov),
    forecastItemsPerOrder,
    costForecasts: resolvedCostForecasts,
    weeks: weekly,
    totals: {
      budget: total("budget"),
      marketingBudget: total("marketingBudget"),
      despatchActual: total("despatchActual"),
      despatchForecast: total("despatchForecast"),
      receipts: money(total("receiptsActual") + total("receiptsForecast")),
      supplierPayments: total("supplierPayments"),
      marketingSpend: total("marketingSpend"),
      variableCosts: total("variableCosts"),
      fixedCosts: total("fixedCosts"),
      vatPayments: total("vatPayments"),
      otherInflows: total("otherInflows"),
      otherOutflows: total("otherOutflows"),
      netCash: total("netCash"),
      closingCash: weekly[weekly.length - 1].closingCash,
      lowestCash: lowWeek?.closingCash || 0,
      lowestCashWeek: lowWeek?.startDate || ""
    },
    vat: {
      enabled: vatSettings.enabled,
      configured: Boolean(vatSettings.enabled && vatSettings.periodEndAnchor),
      periodEndAnchor: vatSettings.periodEndAnchor,
      inputRecoveryPercent: vatSettings.inputRecoveryPercent,
      vatRate: finance.STANDARD_VAT_RATE,
      periods: resolvedVatPeriods,
      warnings: vatWarnings
    }
  };
}

module.exports = {
  addBusinessDays,
  addDays,
  addMonthsClamped,
  allocateDespatchDays,
  buildCashflow,
  buildWeeks,
  mondayOf,
  money,
  monthlyPaymentDates,
  previousCalendarMonthRange,
  previousWeekday,
  publicBudget,
  publicMovement,
  quarterlyVatPeriods,
  vatPaymentDate
};
