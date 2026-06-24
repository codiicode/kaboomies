const test = require("node:test");
const assert = require("node:assert");
const store = require("../store.js");

test("ledger records append-only entries per wallet", () => {
  store.ledger("wX", -5000, "buyin", "real");
  store.ledger("wX", 9500, "payout", "real");
  const l = store.getLedger("wX");
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].delta, -5000);
  assert.strictEqual(l[0].kind, "buyin");
  assert.strictEqual(l[1].delta, 9500);
  assert.strictEqual(typeof l[0].ts, "number");
  assert.strictEqual(l[0].cur, "real");
});
test("getLedger returns [] for unknown wallet", () => {
  assert.deepStrictEqual(store.getLedger("nobody"), []);
});
test("ledger ignores no-op calls", () => {
  const before = store.getLedger("wY").length;
  store.ledger("wY", 0, "noop", "real");
  store.ledger("", 100, "x", "real");
  assert.strictEqual(store.getLedger("wY").length, before);
});
