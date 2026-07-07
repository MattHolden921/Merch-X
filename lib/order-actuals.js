"use strict";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value || "").trim();
}

function normalizeDocumentKind(invoice = {}) {
  const raw = text(invoice.documentKind || invoice.document_kind);
  if (raw === "credit_note" || raw === "credit-note" || raw === "credit note") return "credit_note";
  const type = text(invoice.invoiceType || invoice.invoice_type).toLowerCase();
  return type === "credit note" ? "credit_note" : "invoice";
}

function invoiceSign(invoice = {}) {
  return normalizeDocumentKind(invoice) === "credit_note" ? -1 : 1;
}

function signedInvoiceAmount(invoice = {}) {
  return Math.abs(number(invoice.amount)) * invoiceSign(invoice);
}

function unitCostGbp(line = {}) {
  const quantity = number(line.quantity);
  const lineCost = number(line.lineCost);
  if (quantity > 0 && lineCost > 0) return lineCost / quantity;
  return number(line.unitCostGbp || line.unitCost);
}

function lineValueGbp(line = {}, quantity = 0) {
  return Math.max(0, number(quantity)) * unitCostGbp(line);
}

function calculateReceiptLine(input = {}) {
  const expectedQuantity = Math.max(0, number(input.expectedQuantity));
  const receivedQuantity = Math.max(0, number(input.receivedQuantity));
  const damagedQuantity = Math.min(receivedQuantity, Math.max(0, number(input.damagedQuantity)));
  const hasAccepted = input.acceptedQuantity !== undefined && input.acceptedQuantity !== null && input.acceptedQuantity !== "";
  const acceptedQuantity = Math.min(receivedQuantity, Math.max(0, hasAccepted ? number(input.acceptedQuantity) : receivedQuantity - damagedQuantity));
  const shortQuantity = Math.max(0, expectedQuantity - receivedQuantity);
  const overQuantity = Math.max(0, receivedQuantity - expectedQuantity);
  return {
    expectedQuantity,
    receivedQuantity,
    damagedQuantity,
    acceptedQuantity,
    shortQuantity,
    overQuantity
  };
}

function receiptTotals(lines = []) {
  const totals = (lines || []).reduce((sum, line) => {
    sum.expectedQuantity += number(line.expectedQuantity);
    sum.receivedQuantity += number(line.receivedQuantity);
    sum.damagedQuantity += number(line.damagedQuantity);
    sum.acceptedQuantity += number(line.acceptedQuantity);
    sum.shortQuantity += number(line.shortQuantity);
    sum.overQuantity += number(line.overQuantity);
    return sum;
  }, {
    expectedQuantity: 0,
    receivedQuantity: 0,
    damagedQuantity: 0,
    acceptedQuantity: 0,
    shortQuantity: 0,
    overQuantity: 0
  });
  totals.fillRate = totals.expectedQuantity > 0 ? totals.acceptedQuantity / totals.expectedQuantity : 0;
  totals.hasVariance = totals.shortQuantity > 0 || totals.damagedQuantity > 0 || totals.overQuantity > 0;
  return totals;
}

function discrepancyDraftsForReceipt({ order = {}, batch = {}, receiptLines = [] } = {}) {
  const lines = order.lines || order.order?.lines || [];
  const orderId = text(order.id);
  const batchId = text(batch.id);
  const currency = text(batch.currency || order.terms?.currency || order.currency || "GBP");
  const drafts = [];
  for (const receipt of receiptLines || []) {
    const lineIndex = number(receipt.lineIndex);
    const orderLine = lines[lineIndex] || receipt.line || {};
    const identity = {
      orderId,
      batchId,
      lineIndex,
      receiptLineId: text(receipt.id),
      sku: text(receipt.sku || orderLine.sku),
      buyingCode: text(receipt.buyingCode || orderLine.buyingCode || orderLine.supplierSku),
      style: text(receipt.style || orderLine.style || orderLine.description),
      currency
    };
    for (const [type, quantityKey] of [["shortage", "shortQuantity"], ["damage", "damagedQuantity"], ["overage", "overQuantity"]]) {
      const quantity = Math.max(0, number(receipt[quantityKey]));
      if (!quantity) continue;
      drafts.push({
        ...identity,
        discrepancyType: type,
        quantity,
        valueGbp: lineValueGbp(orderLine, quantity),
        notes: text(receipt.notes),
        sourceKey: [orderId, batchId, lineIndex, type].join(":")
      });
    }
  }
  return drafts;
}

function summarizeDiscrepancies(discrepancies = []) {
  const terminalStatuses = new Set(["Credit received", "Replacement received", "Accepted variance", "Written off", "Resolved"]);
  return (discrepancies || []).reduce((sum, item) => {
    const value = Math.max(0, number(item.valueGbp || item.value_gbp));
    const status = text(item.status || "Open");
    const resolutionType = text(item.resolutionType || item.resolution_type);
    const type = text(item.discrepancyType || item.discrepancy_type);
    const isCredit = resolutionType === "credit_note" || status === "Credit requested" || status === "Credit received";
    sum.count += 1;
    if (!terminalStatuses.has(status)) {
      sum.openCount += 1;
      sum.openValueGbp += value;
    }
    if (type === "shortage") {
      sum.shortUnits += number(item.quantity);
      sum.shortValueGbp += value;
    }
    if (type === "damage") {
      sum.damagedUnits += number(item.quantity);
      sum.damagedValueGbp += value;
    }
    if (type === "overage") {
      sum.overUnits += number(item.quantity);
      sum.overValueGbp += value;
    }
    if (isCredit && !terminalStatuses.has(status)) sum.creditDueGbp += value;
    if (status === "Credit received") sum.creditReceivedGbp += value;
    return sum;
  }, {
    count: 0,
    openCount: 0,
    openValueGbp: 0,
    shortUnits: 0,
    shortValueGbp: 0,
    damagedUnits: 0,
    damagedValueGbp: 0,
    overUnits: 0,
    overValueGbp: 0,
    creditDueGbp: 0,
    creditReceivedGbp: 0
  });
}

function summarizeSupplierCredits(rows = []) {
  const terminalStatuses = new Set(["Credit received", "Replacement received", "Accepted variance", "Written off", "Resolved"]);
  const map = new Map();
  for (const row of rows || []) {
    const status = text(row.status || "Open");
    const resolutionType = text(row.resolutionType || row.resolution_type);
    const isCredit = resolutionType === "credit_note" || status === "Credit requested" || status === "Credit received";
    const value = Math.max(0, number(row.valueGbp || row.value_gbp));
    if (!isCredit || !value) continue;
    const supplierName = text(row.supplierName || row.supplier_name) || "No supplier";
    if (!map.has(supplierName)) {
      map.set(supplierName, {
        supplierName,
        creditDueGbp: 0,
        creditReceivedGbp: 0,
        openCreditCount: 0,
        receivedCreditCount: 0,
        items: []
      });
    }
    const group = map.get(supplierName);
    if (status === "Credit received") {
      group.creditReceivedGbp += value;
      group.receivedCreditCount += 1;
      continue;
    }
    if (terminalStatuses.has(status)) continue;
    group.creditDueGbp += value;
    group.openCreditCount += 1;
    group.items.push({
      id: text(row.id),
      orderId: text(row.orderId || row.order_id),
      orderNumber: text(row.orderNumber || row.order_number),
      batchId: text(row.batchId || row.batch_id),
      lineIndex: number(row.lineIndex || row.line_index),
      discrepancyType: text(row.discrepancyType || row.discrepancy_type),
      status,
      resolutionType,
      sku: text(row.sku),
      buyingCode: text(row.buyingCode || row.buying_code),
      style: text(row.style),
      quantity: number(row.quantity),
      valueGbp: value,
      notes: text(row.notes),
      updatedAt: text(row.updatedAt || row.updated_at || row.createdAt || row.created_at)
    });
  }
  return [...map.values()].map(group => ({
    ...group,
    items: group.items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.orderNumber).localeCompare(String(b.orderNumber)))
  })).sort((a, b) => b.creditDueGbp - a.creditDueGbp || a.supplierName.localeCompare(b.supplierName));
}

function summarizeSupplierPerformance(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const supplier = text(row.supplierName) || "No supplier";
    if (!map.has(supplier)) {
      map.set(supplier, {
        supplierName: supplier,
        orders: 0,
        units: 0,
        valueGbp: 0,
        outstandingGbp: 0,
        orderedUnits: 0,
        receivedUnits: 0,
        acceptedUnits: 0,
        damagedUnits: 0,
        shortUnits: 0,
        overUnits: 0,
        varianceValueGbp: 0,
        openDiscrepancies: 0,
        openCreditValueGbp: 0,
        creditReceivedGbp: 0,
        receivedBatches: 0,
        onTimeBatches: 0,
        lateBatches: 0,
        openBatches: 0
      });
    }
    const group = map.get(supplier);
    const actuals = row.actuals || {};
    const discrepancies = row.discrepancies || {};
    const batches = row.batches || {};
    group.orders += 1;
    group.units += number(row.units);
    group.valueGbp += number(row.totalGbp);
    group.outstandingGbp += number(row.invoices?.outstanding);
    group.orderedUnits += number(actuals.expectedQuantity || row.units);
    group.receivedUnits += number(actuals.receivedQuantity);
    group.acceptedUnits += number(actuals.acceptedQuantity);
    group.damagedUnits += number(actuals.damagedQuantity);
    group.shortUnits += number(actuals.shortQuantity);
    group.overUnits += number(actuals.overQuantity);
    group.varianceValueGbp += number(discrepancies.openValueGbp);
    group.openDiscrepancies += number(discrepancies.openCount);
    group.openCreditValueGbp += number(discrepancies.creditDueGbp);
    group.creditReceivedGbp += number(discrepancies.creditReceivedGbp);
    group.receivedBatches += number(batches.received);
    group.onTimeBatches += number(batches.onTime);
    group.lateBatches += number(batches.late);
    group.openBatches += number(batches.openBatches);
  }
  return [...map.values()].map(group => ({
    ...group,
    fillRate: group.orderedUnits > 0 ? group.acceptedUnits / group.orderedUnits : 0,
    onTimeRate: group.receivedBatches > 0 ? group.onTimeBatches / group.receivedBatches : 0
  })).sort((a, b) => b.valueGbp - a.valueGbp || a.supplierName.localeCompare(b.supplierName));
}

module.exports = {
  calculateReceiptLine,
  discrepancyDraftsForReceipt,
  invoiceSign,
  lineValueGbp,
  normalizeDocumentKind,
  receiptTotals,
  signedInvoiceAmount,
  summarizeDiscrepancies,
  summarizeSupplierCredits,
  summarizeSupplierPerformance,
  unitCostGbp
};
