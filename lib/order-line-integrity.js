"use strict";

function normalizeSku(value) {
  return String(value == null ? "" : value).trim().toUpperCase();
}

function orderSkuSet(order = {}) {
  return new Set((order.lines || []).map(line => normalizeSku(line?.sku)).filter(Boolean));
}

function removedOrderSkus(previousOrder = {}, nextOrder = {}) {
  const nextSkus = orderSkuSet(nextOrder);
  return [...orderSkuSet(previousOrder)].filter(sku => !nextSkus.has(sku));
}

function acknowledgedRemovalsCover(removedSkus = [], acknowledgedSkus = []) {
  const acknowledged = new Set((acknowledgedSkus || []).map(normalizeSku).filter(Boolean));
  return (removedSkus || []).every(sku => acknowledged.has(normalizeSku(sku)));
}

module.exports = { acknowledgedRemovalsCover, normalizeSku, orderSkuSet, removedOrderSkus };
