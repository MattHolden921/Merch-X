"use strict";

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestOrderBySku(orders = []) {
  const latest = new Map();

  orders.forEach((order, index) => {
    const reference = {
      id: String(order?.id || ""),
      orderNumber: String(order?.orderNumber || ""),
      orderDate: String(order?.orderDate || ""),
      savedAt: String(order?.savedAt || "")
    };
    const orderTime = timestamp(reference.orderDate) || timestamp(reference.savedAt);
    const savedTime = timestamp(reference.savedAt);

    for (const line of order?.lines || []) {
      const sku = normalizeSku(line?.sku);
      if (!sku) continue;
      const current = latest.get(sku);
      if (!current || orderTime > current.orderTime ||
        (orderTime === current.orderTime && savedTime > current.savedTime) ||
        (orderTime === current.orderTime && savedTime === current.savedTime && index > current.index)) {
        latest.set(sku, { ...reference, orderTime, savedTime, index });
      }
    }
  });

  return new Map([...latest].map(([sku, reference]) => [sku, {
    id: reference.id,
    orderNumber: reference.orderNumber,
    orderDate: reference.orderDate,
    savedAt: reference.savedAt
  }]));
}

function orderByNumber(orders = []) {
  return new Map(orders
    .filter(order => String(order?.orderNumber || "").trim())
    .map(order => [String(order.orderNumber).trim().toUpperCase(), {
      id: String(order.id || ""),
      orderNumber: String(order.orderNumber || ""),
      orderDate: String(order.orderDate || ""),
      savedAt: String(order.savedAt || "")
    }]));
}

module.exports = { latestOrderBySku, orderByNumber };
