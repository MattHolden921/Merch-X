const crypto = require("node:crypto");

function uniqueIds(ids) {
  const seen = new Set();
  return (ids || []).map(id => String(id || "").trim()).filter(id => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(id => rightSet.has(id));
}

function orderHash(ids) {
  return crypto.createHash("sha256").update((ids || []).map(id => String(id || "").trim()).join("\n")).digest("hex");
}

function normalizeCollectionMoves(moves) {
  if (!Array.isArray(moves)) return [];
  return moves.map((move, index) => {
    const id = String(move?.id || "").trim();
    const position = Number(move?.newPosition);
    if (!id || !Number.isInteger(position) || position < 0) throw new Error(`Invalid collection move at row ${index + 1}.`);
    return { id, newPosition: String(position) };
  });
}

function applyCollectionMove(order, productId, newPosition) {
  const currentIndex = order.indexOf(productId);
  if (currentIndex === -1) return false;
  const targetIndex = Math.max(0, Math.min(order.length - 1, Number(newPosition)));
  if (currentIndex === targetIndex) return false;
  order.splice(currentIndex, 1);
  order.splice(targetIndex, 0, productId);
  return true;
}

function nextCollectionMoveBatch(currentOrder, targetOrder, limit = 250) {
  const moves = [];
  for (let index = 0; index < targetOrder.length && moves.length < limit; index += 1) {
    const wantedId = targetOrder[index];
    if (currentOrder[index] === wantedId) continue;
    const currentIndex = currentOrder.indexOf(wantedId);
    if (currentIndex === -1) continue;
    applyCollectionMove(currentOrder, wantedId, index);
    moves.push({ id: wantedId, newPosition: String(index) });
  }
  return moves;
}

module.exports = {
  applyCollectionMove,
  nextCollectionMoveBatch,
  normalizeCollectionMoves,
  orderHash,
  sameIdSet,
  uniqueIds
};
