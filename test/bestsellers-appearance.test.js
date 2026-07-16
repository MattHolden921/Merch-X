"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAppearanceGrouping() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "bestsellers.html"), "utf8");
  const start = html.indexOf("function extractColour(name)");
  const end = html.indexOf("function getMerchPosProducts(", start);
  assert.ok(start >= 0 && end > start, "appearance-grouping functions should remain available");

  const context = {};
  vm.runInNewContext(html.slice(start, end), context);
  return context.applyAppearanceGrouping;
}

test("style appearance grouping ignores product-title capitalisation", () => {
  const applyAppearanceGrouping = loadAppearanceGrouping();
  const rows = [
    { name: "Meredith Linen Dress Navy" },
    { name: "Solange Dress Pink" },
    { name: "MEREDITH Linen Dress Green" }
  ];

  assert.deepEqual(
    Array.from(applyAppearanceGrouping(rows, "style", 2), row => row.name),
    ["Meredith Linen Dress Navy", "MEREDITH Linen Dress Green", "Solange Dress Pink"]
  );
});
