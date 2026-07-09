const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");
const {
  calculateRrpGbp,
  calculateVatInflatedRegressionRrpGbp
} = require("../public/order-pricing.js");
const {
  buildRepairPlan,
  applyRepairPlan,
  repairOrderData
} = require("../scripts/fix-order-rrp-vat-regression.js");

test("five-times RRP does not add VAT a second time", () => {
  assert.ok(Math.abs(calculateRrpGbp(6.02) - 30.10) < 0.000001);
  assert.ok(Math.abs(calculateVatInflatedRegressionRrpGbp(6.02) - 36.12) < 0.000001);
});

test("order repair changes only the RRP fields", () => {
  const original = {
    lines: [
      { sku: "10001", quantity: 2, unitCostGbp: 6.02, rrp: 36.12, lineCost: 12.04, lineRrp: 72.24 },
      { sku: "10002", quantity: 1, unitCostGbp: 7, rrp: 35, lineCost: 7, lineRrp: 35 }
    ],
    totals: { subtotal: 19.04, vat: 3.808, grand: 19.04, totalRrp: 107.24 }
  };

  const result = repairOrderData(original);
  assert.equal(result.repairedLines, 1);
  assert.ok(Math.abs(result.order.lines[0].rrp - 30.10) < 0.000001);
  assert.ok(Math.abs(result.order.lines[0].lineRrp - 60.20) < 0.000001);
  assert.equal(result.order.lines[1].rrp, 35);
  assert.equal(result.order.totals.subtotal, original.totals.subtotal);
  assert.equal(result.order.totals.vat, original.totals.vat);
  assert.equal(result.order.totals.grand, original.totals.grand);
  assert.ok(Math.abs(result.order.totals.totalRrp - 95.20) < 0.000001);
});

test("database repair fixes affected orders and local products but skips Shopify-linked products", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE products (
      sku TEXT PRIMARY KEY,
      rrp REAL,
      unit_cost_gbp REAL,
      product_status TEXT,
      sync_status TEXT,
      shopify_product_gid TEXT,
      shopify_variant_gid TEXT,
      data TEXT,
      updated_at TEXT
    );
  `);

  const order = {
    lines: [
      { sku: "LOCAL-1", quantity: 1, unitCostGbp: 6, rrp: 36, lineCost: 6, lineRrp: 36 },
      { sku: "LIVE-1", quantity: 1, unitCostGbp: 6, rrp: 36, lineCost: 6, lineRrp: 36 }
    ],
    totals: { subtotal: 12, vat: 2.4, grand: 12, totalRrp: 72 }
  };
  db.prepare("INSERT INTO orders (id, data) VALUES (?, ?)").run("order-1", JSON.stringify(order));
  db.prepare(`
    INSERT INTO products (
      sku, rrp, unit_cost_gbp, product_status, sync_status,
      shopify_product_gid, shopify_variant_gid, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("LOCAL-1", 36, 6, "Draft", "Not synced", "", "", JSON.stringify({
    sku: "LOCAL-1", unitCostGbp: 6, rrp: 36, status: "Draft"
  }));
  db.prepare(`
    INSERT INTO products (
      sku, rrp, unit_cost_gbp, product_status, sync_status,
      shopify_product_gid, shopify_variant_gid, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("LIVE-1", 36, 6, "Live", "Synced draft", "gid://shopify/Product/1", "", JSON.stringify({
    sku: "LIVE-1", unitCostGbp: 6, rrp: 36, status: "Live", shopifyProductGid: "gid://shopify/Product/1"
  }));

  const plan = buildRepairPlan(db);
  assert.equal(plan.orderChanges.length, 1);
  assert.equal(plan.repairedLines, 2);
  assert.equal(plan.productChanges.length, 1);
  assert.deepEqual(plan.skippedShopifySkus, ["LIVE-1"]);

  applyRepairPlan(db, plan);
  const savedOrder = JSON.parse(db.prepare("SELECT data FROM orders WHERE id = ?").get("order-1").data);
  assert.deepEqual(savedOrder.lines.map(line => line.rrp), [30, 30]);
  assert.equal(savedOrder.totals.totalRrp, 60);
  assert.equal(savedOrder.totals.grand, 12);

  const local = db.prepare("SELECT rrp, data FROM products WHERE sku = ?").get("LOCAL-1");
  const linked = db.prepare("SELECT rrp, data FROM products WHERE sku = ?").get("LIVE-1");
  assert.equal(local.rrp, 30);
  assert.equal(JSON.parse(local.data).rrp, 30);
  assert.equal(linked.rrp, 36);
  assert.equal(JSON.parse(linked.data).rrp, 36);
  db.close();
});
