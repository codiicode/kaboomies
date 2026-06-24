const test = require("node:test");
const assert = require("node:assert");
const store = require("../store.js");
const custody = require("../custody.js");

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

test("custody is disabled unless all three env vars are set", () => {
  assert.strictEqual(custody.enabled(), false); // none set in test env
});
test("config exposes positive tunable caps", () => {
  const c = custody.config();
  assert.ok(c.MIN_WITHDRAW > 0);
  assert.ok(c.MAX_PER_TX >= c.MIN_WITHDRAW);
  assert.ok(c.DAILY_CAP >= c.MAX_PER_TX);
  assert.strictEqual(typeof c.PAUSED, "boolean");
});
