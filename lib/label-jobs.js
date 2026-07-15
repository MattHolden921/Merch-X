"use strict";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function normalized(value) {
  return text(value).toUpperCase();
}

function scopeQuantities(order, batchLines = [], scopeType = "order", batchId = "", selectedLineIndexes = []) {
  const lines = order?.lines || [];
  const selected = new Set((selectedLineIndexes || []).map(Number).filter(Number.isInteger));
  const allocated = new Map();
  for (const allocation of batchLines || []) {
    const lineIndex = Number(allocation.lineIndex || 0);
    allocated.set(lineIndex, (allocated.get(lineIndex) || 0) + Number(allocation.quantity || 0));
  }
  return lines.map((line, lineIndex) => {
    const ordered = Math.max(0, Number(line.quantity || 0));
    let quantity = ordered;
    if (scopeType === "unbatched") quantity = Math.max(0, ordered - (allocated.get(lineIndex) || 0));
    if (scopeType === "batch") {
      quantity = (batchLines || [])
        .filter(item => text(item.batchId) === text(batchId) && Number(item.lineIndex) === lineIndex)
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    }
    return { line, lineIndex, quantity };
  }).filter(item => item.quantity > 0 && (!selected.size || selected.has(item.lineIndex)));
}

function matchKey(line) {
  return [
    text(line.buyingCode || line.supplierSku) || "NO BUYING CODE",
    text(line.colour || line.color) || "NO COLOUR",
    text(line.size),
    text(line.sku)
  ].filter(Boolean).join(" - ");
}

function normalizeDoubleBarcodeSnapshot(snapshot = {}) {
  const rows = (snapshot.rows || []).map(row => {
    const orderedQuantity = Math.max(0, Number(row.orderedQuantity || 0));
    const spareQuantity = Math.max(0, Number(row.spareQuantity || 0));
    const applicationLabels = orderedQuantity * 2;
    return {
      ...row,
      labelSize: row.labelSize || snapshot.labelSize || "60 x 40 mm",
      labelsPerUnit: 2,
      applicationLabels,
      labelsRequired: applicationLabels + spareQuantity
    };
  });
  return {
    ...snapshot,
    applicationRequirement: "Apply two identical barcode labels per product: one to the swing ticket and one to the outer packaging.",
    labelSize: snapshot.labelSize || "60 x 40 mm",
    rows,
    totals: {
      ...(snapshot.totals || {}),
      skus: rows.length,
      orderedUnits: rows.reduce((sum, row) => sum + row.orderedQuantity, 0),
      applicationLabels: rows.reduce((sum, row) => sum + row.applicationLabels, 0),
      spareLabels: rows.reduce((sum, row) => sum + row.spareQuantity, 0),
      labelsRequired: rows.reduce((sum, row) => sum + row.labelsRequired, 0)
    }
  };
}

function buildLabelJobSnapshot({ order, batchLines = [], batches = [], scopeType = "order", batchId = "", selectedLineIndexes = [], selectionRequired = false, sparePerSku = 0, labelTemplate = "60 x 40 mm swing-ticket barcode", placementInstructions = "" } = {}) {
  const errors = [];
  const warnings = [];
  const selected = [...new Set((selectedLineIndexes || []).map(Number).filter(Number.isInteger))];
  const scoped = selectionRequired && !selected.length ? [] : scopeQuantities(order, batchLines, scopeType, batchId, selected);
  const spare = Math.max(0, Math.min(100, Math.floor(Number(sparePerSku || 0))));
  if (selectionRequired && !selected.length) errors.push("Select at least one extra order line to generate.");
  else if (!scoped.length) errors.push("The selected scope has no units to label.");

  const bySku = new Map();
  for (const item of scoped) {
    const line = item.line || {};
    const sku = normalized(line.sku);
    const label = `Line ${item.lineIndex + 1}${sku ? ` (${sku})` : ""}`;
    if (!sku) {
      errors.push(`${label} is missing a SKU.`);
      continue;
    }
    if (!/^[\x20-\x7E]+$/.test(sku)) errors.push(`${label} contains characters that are not supported by the Code 128 label proof.`);
    if (!Number.isInteger(item.quantity)) errors.push(`${label} has a non-whole quantity; label quantities must be whole units.`);
    const row = {
      lineIndex: item.lineIndex,
      sku,
      barcodeValue: sku,
      barcodeFormat: "Code 128",
      buyingCode: text(line.buyingCode || line.supplierSku),
      style: text(line.style || line.description),
      category: text(line.category),
      colour: text(line.colour || line.color),
      size: text(line.size),
      orderedQuantity: item.quantity,
      labelsPerUnit: 2,
      applicationLabels: item.quantity * 2,
      spareQuantity: spare,
      labelsRequired: (item.quantity * 2) + spare,
      rrp: Number(line.rrp || 0),
      imageUrl: text(line.imageUrl || line.confirmedImageUrl || line.pendingImageUrl),
      labelSize: "60 x 40 mm",
      labelTemplate: text(labelTemplate) || "60 x 40 mm swing-ticket barcode"
    };
    row.matchKey = matchKey(row);
    const existing = bySku.get(sku);
    if (existing) {
      const identityFields = ["buyingCode", "style", "colour", "size", "rrp", "labelTemplate"];
      const conflict = identityFields.some(key => normalized(existing[key]) !== normalized(row[key]));
      if (conflict) errors.push(`SKU ${sku} appears more than once with conflicting label details.`);
      else {
        existing.orderedQuantity += row.orderedQuantity;
        existing.applicationLabels += row.applicationLabels;
        existing.labelsRequired += row.applicationLabels;
        existing.lineIndexes.push(item.lineIndex);
      }
    } else {
      row.lineIndexes = [item.lineIndex];
      bySku.set(sku, row);
    }
  }

  const rows = [...bySku.values()];
  const buyingCodeGroups = new Map();
  for (const row of rows) {
    if (!row.buyingCode) {
      warnings.push(`SKU ${row.sku} has no buying code; the supplier guide will use its style and SKU.`);
      continue;
    }
    const key = normalized(row.buyingCode);
    if (!buyingCodeGroups.has(key)) buyingCodeGroups.set(key, []);
    buyingCodeGroups.get(key).push(row);
  }
  for (const group of buyingCodeGroups.values()) {
    if (group.length < 2) continue;
    if (group.some(row => !row.colour)) errors.push(`Buying code ${group[0].buyingCode} is shared across SKUs, so every variation needs a colour.`);
    const byColour = new Map();
    for (const row of group) {
      const colour = normalized(row.colour);
      if (!byColour.has(colour)) byColour.set(colour, []);
      byColour.get(colour).push(row);
    }
    for (const colourRows of byColour.values()) {
      if (colourRows.length > 1 && colourRows.some(row => !row.size)) {
        errors.push(`Buying code ${group[0].buyingCode} / ${colourRows[0].colour || "no colour"} has multiple SKUs, so every variation needs a size.`);
      }
    }
  }
  for (const row of rows) {
    if (!row.style) warnings.push(`SKU ${row.sku} has no style description.`);
    if (!row.colour) warnings.push(`SKU ${row.sku} has no colour.`);
    if (!row.imageUrl) warnings.push(`SKU ${row.sku} has no image for the supplier guide.`);
  }

  const batch = scopeType === "batch" ? (batches || []).find(item => text(item.id) === text(batchId)) : null;
  const baseScopeLabel = scopeType === "batch"
    ? text(batch?.title || batch?.batchNumber) || "Selected batch"
    : scopeType === "unbatched" ? "Unbatched / remaining" : "Full order";
  const scopeLabel = selected.length ? `Selected lines (${scoped.length}) from ${baseScopeLabel}` : baseScopeLabel;
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    scopeType,
    batchId: scopeType === "batch" ? text(batchId) : "",
    scopeLabel,
    selectionMode: selected.length || selectionRequired ? "selected" : "all",
    selectedLineIndexes: selected,
    barcodePolicy: "SKU encoded as Code 128",
    applicationRequirement: "Apply two identical barcode labels per product: one to the swing ticket and one to the outer packaging.",
    labelSize: "60 x 40 mm",
    labelTemplate: text(labelTemplate) || "60 x 40 mm swing-ticket barcode",
    placementInstructions: text(placementInstructions),
    sparePerSku: spare,
    rows,
    totals: {
      skus: rows.length,
      orderedUnits: rows.reduce((sum, row) => sum + row.orderedQuantity, 0),
      applicationLabels: rows.reduce((sum, row) => sum + row.applicationLabels, 0),
      spareLabels: rows.reduce((sum, row) => sum + row.spareQuantity, 0),
      labelsRequired: rows.reduce((sum, row) => sum + row.labelsRequired, 0)
    }
  };
}

module.exports = { buildLabelJobSnapshot, matchKey, normalizeDoubleBarcodeSnapshot, scopeQuantities };
