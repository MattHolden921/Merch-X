"use strict";

const { scopeQuantities } = require("./label-jobs");

const PAH_HEADERS = [
  "PAH:PRE_ADVICE_ID", "PAH:PRE_ADVICE_TYPE", "PAH:SUPPLIER_ID", "PAH:DUE_DSTAMP",
  "PAH:CONTACT", "PAH:CONTACT_PHONE", "PAH:CONTACT_EMAIL", "PAH:NAME",
  "PAH:ADDRESS1", "PAH:ADDRESS2", "PAH:TOWN", "PAH:COUNTY", "PAH:POSTCODE",
  "PAH:COUNTRY", "PAH:RETURN_FLAG", "PAH:NOTES", "PAH:USER_DEF_TYPE_1",
  "PAL:SKU_ID", "PAL:QTY_DUE", "PAL:USER_DEF_TYPE_1"
];

const DEFAULT_PAH_SETTINGS = {
  preAdviceType: "Web",
  supplierId: "KAK",
  contact: "Europe Logistics Ltd",
  contactPhone: "01394 786024",
  contactEmail: "rebecca@europelogistics.co.uk",
  name: "Rebecca Bird",
  address1: "Valbro Business Park",
  address2: "",
  town: "Leicester",
  county: "Leicestershire",
  postcode: "LE4 9LF",
  country: "UK",
  returnFlag: "N"
};

function text(value) {
  return String(value == null ? "" : value).trim();
}

function safeSettings(value = {}) {
  return Object.fromEntries(Object.keys(DEFAULT_PAH_SETTINGS).map(key => [key, text(value[key] ?? DEFAULT_PAH_SETTINGS[key])]));
}

function csvCell(value) {
  const result = String(value == null ? "" : value);
  return /[",\r\n]/.test(result) ? `"${result.replace(/"/g, '""')}"` : result;
}

function csv(rows) {
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function formatPahDate(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function safeReference(value) {
  return text(value).replace(/[^A-Z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

function buildPreAdviceId(orderNumber, scopeType, batch) {
  const base = safeReference(orderNumber) || "ORDER";
  if (scopeType !== "batch") return base;
  const batchRef = safeReference(batch?.batchNumber || batch?.title || batch?.id) || "BATCH";
  return `${base}-${batchRef}`;
}

function buildPahReport({ order, batches = [], batchLines = [], scopeType = "order", batchId = "", settings = {} } = {}) {
  const errors = [];
  const cleanScope = ["order", "batch", "unbatched"].includes(scopeType) ? scopeType : "order";
  const batch = cleanScope === "batch" ? batches.find(item => text(item.id) === text(batchId)) : null;
  if (cleanScope === "batch" && !batch) errors.push("The selected supplier batch no longer exists.");
  const scoped = scopeQuantities(order, batchLines, cleanScope, batchId);
  if (!scoped.length) errors.push("The selected scope has no units to include in the PAH report.");
  const dueDate = batch?.etaDate || order?.workflow?.intakeEtaDate || order?.delivery?.requiredDate || order?.requiredDate || "";
  if (!formatPahDate(dueDate)) errors.push("Add an ETA warehouse date before exporting the PAH report.");
  const config = safeSettings(settings);
  for (const key of ["preAdviceType", "supplierId", "contact", "contactPhone", "contactEmail", "name", "address1", "town", "postcode", "country", "returnFlag"]) {
    if (!config[key]) errors.push(`PAH carrier setting ${key} is required.`);
  }
  for (const item of scoped) {
    if (!text(item.line?.sku)) errors.push(`Order line ${item.lineIndex + 1} is missing a SKU.`);
    if (!Number.isInteger(item.quantity)) errors.push(`Order line ${item.lineIndex + 1} has a non-whole PAH quantity.`);
  }
  if (errors.length) return { valid: false, errors: [...new Set(errors)], rows: [] };

  const preAdviceId = buildPreAdviceId(order?.orderNumber, cleanScope, batch);
  const rows = scoped.map(item => {
    const line = item.line || {};
    return [
      preAdviceId, config.preAdviceType, config.supplierId, formatPahDate(dueDate), config.contact,
      config.contactPhone, config.contactEmail, config.name, config.address1, config.address2,
      config.town, config.county, config.postcode, config.country, config.returnFlag, "",
      text(line.style || line.description), text(line.sku), item.quantity, text(line.colour || line.color)
    ];
  });
  const scopeLabel = cleanScope === "batch" ? text(batch.title || batch.batchNumber) : cleanScope === "unbatched" ? "Unbatched" : "Full order";
  return {
    valid: true,
    errors: [],
    preAdviceId,
    scopeType: cleanScope,
    scopeLabel,
    dueDate,
    units: rows.reduce((sum, row) => sum + Number(row[18] || 0), 0),
    filename: `PAH ${preAdviceId}.csv`,
    rows,
    content: csv([PAH_HEADERS, ...rows])
  };
}

module.exports = { DEFAULT_PAH_SETTINGS, PAH_HEADERS, buildPahReport, csv, formatPahDate, safeSettings };
