const test = require("node:test");
const assert = require("node:assert/strict");
const reorder = require("../lib/collection-reorder");

test("order hashes are stable and order-sensitive", () => {
  assert.equal(reorder.orderHash(["a", "b"]), reorder.orderHash(["a", "b"]));
  assert.notEqual(reorder.orderHash(["a", "b"]), reorder.orderHash(["b", "a"]));
});

test("move batches converge on the target order", () => {
  const current = Array.from({ length: 600 }, (_, index) => String(index));
  const target = [...current].reverse();
  let batches = 0;
  while (reorder.nextCollectionMoveBatch(current, target, 250).length) batches += 1;
  assert.deepEqual(current, target);
  assert.ok(batches >= 3);
});

test("rejects invalid moves and preserves untouched relative order", () => {
  assert.throws(() => reorder.normalizeCollectionMoves([{ id: "a", newPosition: -1 }]), /Invalid collection move/);
  const order = ["a", "b", "c", "d"];
  reorder.applyCollectionMove(order, "d", 1);
  assert.deepEqual(order, ["a", "d", "b", "c"]);
});
