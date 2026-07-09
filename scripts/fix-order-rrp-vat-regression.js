#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const {
  calculateRrpGbp,
  calculateVatInflatedRegressionRrpGbp
} = require("../public/order-pricing.js");

const projectRoot = path.resolve(__dirname, "..");
const regressionFingerprintTolerance = 0.000001;

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function nearlyEqual(left, right, tolerance = regressionFingerprintTolerance) {
  return Math.abs(number(left) - number(right)) <= tolerance;
}

function isVatInflatedRegressionRrp(rrp, unitCostGbp) {
  const cost = number(unitCostGbp);
  const retail = number(rrp);
  return cost > 0
    && retail > 0
    && nearlyEqual(retail, calculateVatInflatedRegressionRrpGbp(cost));
}

function repairOrderData(input) {
  const order = JSON.parse(JSON.stringify(input || {}));
  const repairedSkus = new Set();
  let repairedLines = 0;

  for (const line of order.lines || []) {
    const unitCostGbp = number(line.unitCostGbp || line.unitCost);
    if (!isVatInflatedRegressionRrp(line.rrp, unitCostGbp)) continue;
    line.rrp = calculateRrpGbp(unitCostGbp);
    line.lineRrp = number(line.quantity) * line.rrp;
    repairedLines += 1;
    if (line.sku) repairedSkus.add(normalizeSku(line.sku));
  }

  if (repairedLines && order.totals) {
    order.totals.totalRrp = (order.lines || []).reduce((total, line) => {
      const lineRrp = number(line.lineRrp);
      if (lineRrp) return total + lineRrp;
      return total + (number(line.quantity) * number(line.rrp));
    }, 0);
  }

  return { order, repairedLines, repairedSkus };
}

function parseData(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function productHasShopifyIdentity(row, data) {
  const status = String(data.status || row.product_status || "").trim().toLowerCase();
  const syncStatus = String(data.syncStatus || row.sync_status || "").trim().toLowerCase();
  return Boolean(
    data.shopifyProductGid
    || data.shopifyVariantGid
    || row.shopify_product_gid
    || row.shopify_variant_gid
    || ["shopify draft", "live"].includes(status)
    || syncStatus === "synced draft"
  );
}

function repairProductRow(row, affectedSkus) {
  const sku = normalizeSku(row.sku);
  if (!affectedSkus.has(sku)) return { changed: false, skippedShopify: false, row };

  const data = parseData(row.data);
  const dataCost = number(data.unitCostGbp ?? data.unitCost ?? row.unit_cost_gbp);
  const indexedCost = number(row.unit_cost_gbp || dataCost);
  const repairDataRrp = Object.prototype.hasOwnProperty.call(data, "rrp")
    && isVatInflatedRegressionRrp(data.rrp, dataCost);
  const repairIndexedRrp = isVatInflatedRegressionRrp(row.rrp, indexedCost);
  if (!repairDataRrp && !repairIndexedRrp) return { changed: false, skippedShopify: false, row };

  if (productHasShopifyIdentity(row, data)) {
    return { changed: false, skippedShopify: true, sku, row };
  }

  if (repairDataRrp) data.rrp = calculateRrpGbp(dataCost);
  return {
    changed: true,
    skippedShopify: false,
    sku,
    row: {
      ...row,
      rrp: repairIndexedRrp ? calculateRrpGbp(indexedCost) : row.rrp,
      data: JSON.stringify(data)
    }
  };
}

function buildRepairPlan(db) {
  const orderChanges = [];
  const affectedSkus = new Set();
  let repairedLines = 0;

  for (const row of db.prepare("SELECT id, data FROM orders").all()) {
    const repaired = repairOrderData(parseData(row.data));
    if (!repaired.repairedLines) continue;
    repairedLines += repaired.repairedLines;
    for (const sku of repaired.repairedSkus) affectedSkus.add(sku);
    orderChanges.push({ id: row.id, data: JSON.stringify(repaired.order) });
  }

  const productChanges = [];
  const skippedShopifySkus = [];
  const productRows = db.prepare(`
    SELECT sku, rrp, unit_cost_gbp, product_status, sync_status,
      shopify_product_gid, shopify_variant_gid, data
    FROM products
  `).all();
  for (const row of productRows) {
    const repaired = repairProductRow(row, affectedSkus);
    if (repaired.skippedShopify) skippedShopifySkus.push(repaired.sku);
    if (repaired.changed) productChanges.push(repaired.row);
  }

  return {
    orderChanges,
    productChanges,
    affectedSkus,
    skippedShopifySkus: [...new Set(skippedShopifySkus)].sort(),
    repairedLines
  };
}

function applyRepairPlan(db, plan) {
  const updateOrder = db.prepare(`
    UPDATE orders
    SET data = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const updateProduct = db.prepare(`
    UPDATE products
    SET rrp = ?, data = ?, updated_at = CURRENT_TIMESTAMP
    WHERE sku = ?
  `);
  db.transaction(() => {
    for (const row of plan.orderChanges) updateOrder.run(row.data, row.id);
    for (const row of plan.productChanges) updateProduct.run(row.rrp, row.data, row.sku);
  })();
}

function envDatabasePath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return "";
  const match = fs.readFileSync(envPath, "utf8").match(/^\s*DATABASE_PATH\s*=\s*(.+?)\s*$/m);
  return match ? match[1].replace(/^(['"])(.*)\1$/, "$2") : "";
}

function optionValue(args, name) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const configuredPath = optionValue(args, "--database") || envDatabasePath() || path.join("data", "merch-x.sqlite");
  const databasePath = path.resolve(projectRoot, configuredPath);
  const backupDir = path.resolve(optionValue(args, "--backup-dir") || path.dirname(databasePath));
  const db = new Database(databasePath, { readonly: !apply, fileMustExist: true });

  try {
    const plan = buildRepairPlan(db);
    const summary = {
      mode: apply ? "apply" : "dry-run",
      database: databasePath,
      affectedOrders: plan.orderChanges.length,
      affectedOrderLines: plan.repairedLines,
      affectedSkus: plan.affectedSkus.size,
      localProductsToRepair: plan.productChanges.length,
      shopifyLinkedProductsSkipped: plan.skippedShopifySkus.length,
      skippedShopifySkus: plan.skippedShopifySkus
    };

    if (!apply) {
      console.log(JSON.stringify({
        ...summary,
        nextStep: "Review this audit, then rerun with --apply. Applying creates a SQLite backup first."
      }, null, 2));
      return;
    }

    if (!plan.orderChanges.length && !plan.productChanges.length) {
      console.log(JSON.stringify({ ...summary, changed: false, backup: "" }, null, 2));
      return;
    }

    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `merch-x.before-rrp-fix-${stamp}.sqlite`);
    await db.backup(backupPath);
    applyRepairPlan(db, plan);
    console.log(JSON.stringify({ ...summary, changed: true, backup: backupPath }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  isVatInflatedRegressionRrp,
  repairOrderData,
  repairProductRow,
  buildRepairPlan,
  applyRepairPlan,
  productHasShopifyIdentity
};
