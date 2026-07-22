const crypto = require("node:crypto");

function dateOnly(value) {
  if (!value) return "";
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) return "";
  const parsed = new Date(`${match[0]}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? match[0] : "";
}

function cutoffDate(olderThanDays, now = new Date()) {
  const days = Math.max(1, Math.floor(Number(olderThanDays || 0)));
  const cutoff = new Date(now);
  if (!Number.isFinite(cutoff.getTime())) throw new Error("A valid current date is required.");
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().slice(0, 10);
}

function liveDate(product) {
  const published = dateOnly(product?.publishedAt);
  if (published) return published;
  return String(product?.status || "").toUpperCase() === "ACTIVE" ? dateOnly(product?.createdAt) : "";
}

function hasExactTag(tags, requiredTag) {
  const target = String(requiredTag || "").trim();
  if (!target) return true;
  return (Array.isArray(tags) ? tags : []).some(tag => String(tag || "").trim() === target);
}

function cleanupCandidates(products, cutoff, requiredTag = "") {
  const boundary = dateOnly(cutoff);
  if (!boundary) throw new Error("A valid cleanup cutoff date is required.");
  return (products || [])
    .map(product => ({ ...product, liveDate: liveDate(product) }))
    .filter(product => product.id && hasExactTag(product.tags, requiredTag) && product.liveDate && product.liveDate < boundary)
    .sort((left, right) => left.liveDate.localeCompare(right.liveDate) || String(left.title || "").localeCompare(String(right.title || ""), "en-GB"));
}

function previewHash(collectionId, cutoff, products) {
  const ids = (products || []).map(product => String(product?.id || product)).filter(Boolean).sort();
  return crypto.createHash("sha256").update([String(collectionId || ""), dateOnly(cutoff), ...ids].join("\n")).digest("hex");
}

module.exports = { cleanupCandidates, cutoffDate, dateOnly, hasExactTag, liveDate, previewHash };
