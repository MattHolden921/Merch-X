(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MerchOrderReceiptImport = api;
})(typeof self !== "undefined" ? self : this, function() {
  "use strict";

  const HEADER_ALIASES = {
    preAdviceId: ["pre advice id", "preadvice id", "po", "po number", "purchase order", "purchase order number", "order number"],
    sku: ["sku", "our sku", "product sku", "item sku", "stock code", "product code"],
    description: ["description", "product description", "item description", "style"],
    qtyDue: ["qty due", "quantity due", "due qty", "expected", "expected qty", "expected quantity", "qty expected", "ordered qty", "ordered quantity"],
    qtyReceived: ["qty received", "quantity received", "received", "received qty", "received quantity", "actual qty", "actual quantity", "actual received", "booked in", "qty booked in", "quantity booked in"],
    damagedQuantity: ["qty damaged", "quantity damaged", "damaged", "damaged qty", "damaged quantity", "reject qty", "rejected qty"],
    acceptedQuantity: ["qty accepted", "quantity accepted", "accepted", "accepted qty", "accepted quantity"],
    notes: ["notes", "note", "comments", "comment", "remarks"]
  };

  function cellText(value) {
    return String(value == null ? "" : value).replace(/\u00a0/g, " ").trim();
  }

  function normalizeHeader(value) {
    return cellText(value)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[%()]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function compactHeader(value) {
    return normalizeHeader(value).replace(/\s+/g, "");
  }

  function normalizeSku(value) {
    return cellText(value).replace(/^'+/, "").replace(/^(\d+)\.0+$/, "$1").toUpperCase();
  }

  function numericValue(value, fallback = 0) {
    if (value == null || value === "") return fallback;
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    const text = cellText(value).replace(/,/g, "");
    if (!text) return fallback;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function aliasSet(name) {
    const aliases = HEADER_ALIASES[name] || [];
    const set = new Set();
    for (const alias of aliases) {
      set.add(normalizeHeader(alias));
      set.add(compactHeader(alias));
    }
    return set;
  }

  function findHeaderIndex(row, name) {
    const aliases = aliasSet(name);
    return (row || []).findIndex(value => {
      const normalized = normalizeHeader(value);
      if (!normalized) return false;
      return aliases.has(normalized) || aliases.has(normalized.replace(/\s+/g, ""));
    });
  }

  function detectColumns(row) {
    return {
      preAdviceId: findHeaderIndex(row, "preAdviceId"),
      sku: findHeaderIndex(row, "sku"),
      description: findHeaderIndex(row, "description"),
      qtyDue: findHeaderIndex(row, "qtyDue"),
      qtyReceived: findHeaderIndex(row, "qtyReceived"),
      damagedQuantity: findHeaderIndex(row, "damagedQuantity"),
      acceptedQuantity: findHeaderIndex(row, "acceptedQuantity"),
      notes: findHeaderIndex(row, "notes")
    };
  }

  function findHeaderRow(rows) {
    for (let rowIndex = 0; rowIndex < (rows || []).length; rowIndex += 1) {
      const columns = detectColumns(rows[rowIndex]);
      if (columns.sku >= 0 && columns.qtyReceived >= 0) return { rowIndex, columns };
    }
    return null;
  }

  function valueAt(row, index) {
    return index >= 0 ? row[index] : "";
  }

  function mergeLine(existing, next) {
    existing.receivedQuantity += next.receivedQuantity;
    existing.damagedQuantity += next.damagedQuantity;
    existing.acceptedQuantity += next.acceptedQuantity;
    existing.dueQuantity = existing.dueQuantity == null || next.dueQuantity == null ? null : existing.dueQuantity + next.dueQuantity;
    existing.rowNumbers.push(...next.rowNumbers);
    if (next.preAdviceId && !existing.preAdviceIds.includes(next.preAdviceId)) existing.preAdviceIds.push(next.preAdviceId);
    if (next.description && !existing.description) existing.description = next.description;
    if (next.notes) existing.notes = [existing.notes, next.notes].filter(Boolean).join("; ");
    return existing;
  }

  function parseWarehouseReceiptRows(rows) {
    if (!Array.isArray(rows)) {
      return { ok: false, error: "Warehouse report rows were not readable.", lines: [], references: [], warnings: [] };
    }
    const header = findHeaderRow(rows);
    if (!header) {
      return { ok: false, error: "Could not find SKU and Qty Received columns in the warehouse report.", lines: [], references: [], warnings: [] };
    }

    const bySku = new Map();
    const references = [];
    for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      const sku = cellText(valueAt(row, header.columns.sku));
      const normalizedSku = normalizeSku(sku);
      if (!normalizedSku) continue;

      const preAdviceId = cellText(valueAt(row, header.columns.preAdviceId));
      const dueQuantity = header.columns.qtyDue >= 0 ? numericValue(valueAt(row, header.columns.qtyDue), null) : null;
      const receivedQuantity = numericValue(valueAt(row, header.columns.qtyReceived), 0);
      const damagedQuantity = header.columns.damagedQuantity >= 0 ? numericValue(valueAt(row, header.columns.damagedQuantity), 0) : 0;
      const acceptedFallback = Math.max(0, receivedQuantity - damagedQuantity);
      const acceptedQuantity = header.columns.acceptedQuantity >= 0 ? numericValue(valueAt(row, header.columns.acceptedQuantity), acceptedFallback) : acceptedFallback;
      const parsed = {
        sku,
        normalizedSku,
        preAdviceId,
        description: cellText(valueAt(row, header.columns.description)),
        dueQuantity,
        receivedQuantity: Math.max(0, receivedQuantity),
        damagedQuantity: Math.max(0, damagedQuantity),
        acceptedQuantity: Math.min(Math.max(0, receivedQuantity), Math.max(0, acceptedQuantity)),
        notes: cellText(valueAt(row, header.columns.notes)),
        rowNumbers: [rowIndex + 1],
        preAdviceIds: preAdviceId ? [preAdviceId] : []
      };
      if (preAdviceId && !references.includes(preAdviceId)) references.push(preAdviceId);
      const existing = bySku.get(normalizedSku);
      if (existing) mergeLine(existing, parsed);
      else bySku.set(normalizedSku, parsed);
    }

    const lines = [...bySku.values()];
    const totals = lines.reduce((sum, line) => {
      sum.lines += 1;
      sum.dueQuantity += Number(line.dueQuantity || 0);
      sum.receivedQuantity += Number(line.receivedQuantity || 0);
      sum.damagedQuantity += Number(line.damagedQuantity || 0);
      sum.acceptedQuantity += Number(line.acceptedQuantity || 0);
      return sum;
    }, { lines: 0, dueQuantity: 0, receivedQuantity: 0, damagedQuantity: 0, acceptedQuantity: 0 });

    return {
      ok: true,
      headerRow: header.rowIndex + 1,
      columns: header.columns,
      lines,
      references,
      totals,
      warnings: lines.length ? [] : ["No SKU rows were found below the warehouse report header."]
    };
  }

  return {
    cellText,
    normalizeHeader,
    normalizeSku,
    parseWarehouseReceiptRows
  };
});
