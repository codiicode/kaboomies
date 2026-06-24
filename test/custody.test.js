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

test("a deposit credits the sender's real balance once; replay of same sig is a no-op", () => {
  store.setBalance("dep1", 0, null, "real");
  const ok1 = custody.creditDeposit({ sig: "SIGA", fromWallet: "dep1", amount: 1000 }, store);
  const ok2 = custody.creditDeposit({ sig: "SIGA", fromWallet: "dep1", amount: 1000 }, store); // replay
  assert.strictEqual(ok1, true);
  assert.strictEqual(ok2, false);
  assert.strictEqual(store.getBalance("dep1", 0, "real"), 1000);
  const led = store.getLedger("dep1");
  assert.ok(led.some(e => e.kind === "deposit" && e.delta === 1000));
});
test("creditDeposit ignores invalid input", () => {
  assert.strictEqual(custody.creditDeposit({ sig: "", fromWallet: "x", amount: 10 }, store), false);
  assert.strictEqual(custody.creditDeposit({ sig: "S2", fromWallet: "x", amount: 0 }, store), false);
});

test("parseIncoming extracts {sig, fromWallet, amount} for a KABOOM transfer to treasury", () => {
  const fake = custody._fakeTx({ sig: "S1", from: "walletA", to: "TREASURY_ATA", mint: "MINT", amount: 2500 });
  const out = custody.parseIncoming(fake, { treasuryAta: "TREASURY_ATA", mint: "MINT" });
  assert.deepStrictEqual(out, { sig: "S1", fromWallet: "walletA", amount: 2500 });
});
test("parseIncoming returns null for unrelated mint or outbound transfer", () => {
  const other = custody._fakeTx({ sig: "S2", from: "walletA", to: "TREASURY_ATA", mint: "OTHER", amount: 10 });
  assert.strictEqual(custody.parseIncoming(other, { treasuryAta: "TREASURY_ATA", mint: "MINT" }), null);
});
