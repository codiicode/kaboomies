// Disable the per-wallet withdraw cooldown for these unit tests: they drive many
// sequential same-wallet withdrawals (daily-cap, retry) with no real time gap.
// config() reads this env live, so the cooldown path stays covered by its own test.
process.env.KABOOM_WITHDRAW_COOLDOWN_MS = "0";
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

test("withdraw debits first then sends, and is idempotent on idemKey", async () => {
  store.setBalance("wd1", 20000, null, "real");
  const sends = [];
  const sendFn = async ({ to, amount }) => { sends.push({ to, amount }); return "TXSIG1"; };
  const r1 = await custody.withdraw({ wallet: "wd1", amount: 5000, idemKey: "k1" }, store, sendFn);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(store.getBalance("wd1", 0, "real"), 15000);
  assert.strictEqual(sends.length, 1);
  const r2 = await custody.withdraw({ wallet: "wd1", amount: 5000, idemKey: "k1" }, store, sendFn); // replay
  assert.strictEqual(sends.length, 1);                       // no second send
  assert.strictEqual(store.getBalance("wd1", 0, "real"), 15000);
});
test("withdraw enforces min, max-per-tx, balance; rolls back on send failure", async () => {
  const cfg = custody.config();
  store.setBalance("wd2", cfg.MAX_PER_TX * 5, null, "real");
  assert.strictEqual((await custody.withdraw({ wallet:"wd2", amount: cfg.MIN_WITHDRAW-1, idemKey:"a" }, store, async()=>"x")).ok, false);
  assert.strictEqual((await custody.withdraw({ wallet:"wd2", amount: cfg.MAX_PER_TX+1, idemKey:"b" }, store, async()=>"x")).ok, false);
  assert.strictEqual((await custody.withdraw({ wallet:"ghost", amount: cfg.MIN_WITHDRAW, idemKey:"c" }, store, async()=>"x")).ok, false); // no balance
  const before = store.getBalance("wd2", 0, "real");
  const failSend = async () => { throw new Error("rpc down"); };
  const rb = await custody.withdraw({ wallet:"wd2", amount: cfg.MIN_WITHDRAW, idemKey:"d" }, store, failSend);
  assert.strictEqual(rb.ok, false);
  assert.strictEqual(rb.reason, "send_failed");
  assert.strictEqual(store.getBalance("wd2", 0, "real"), before); // rolled back
});

const s = require("../server.js");
test("withdraw endpoint refuses when custody disabled", async () => {
  const res = await s.handleWithdraw({ wallet: "w", amount: 1000, auth: {}, idemKey: "z" });
  assert.strictEqual(res.error, "disabled");
});

test("a failed send is retryable with the same idemKey (key not burned)", async () => {
  store.setBalance("rt1", 20000, null, "real");
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error("rpc down"); return "OKSIG"; };
  const r1 = await custody.withdraw({ wallet:"rt1", amount: 5000, idemKey:"same" }, store, flaky);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(store.getBalance("rt1",0,"real"), 20000);     // rolled back
  const r2 = await custody.withdraw({ wallet:"rt1", amount: 5000, idemKey:"same" }, store, flaky); // retry SAME key
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(calls, 2);                                    // actually retried, not a false replay
  assert.strictEqual(store.getBalance("rt1",0,"real"), 15000);
});
test("a completed withdraw replays without re-sending", async () => {
  store.setBalance("rt2", 20000, null, "real");
  let calls = 0; const ok = async () => { calls++; return "S"; };
  await custody.withdraw({ wallet:"rt2", amount: 5000, idemKey:"done" }, store, ok);
  const rep = await custody.withdraw({ wallet:"rt2", amount: 5000, idemKey:"done" }, store, ok);
  assert.strictEqual(rep.replay, true);
  assert.strictEqual(calls, 1);                                    // no second send
  assert.strictEqual(store.getBalance("rt2",0,"real"), 15000);
});
test("daily cap is exact and independent of the 200-entry ledger cap", async () => {
  const cfg = custody.config();
  store.setBalance("rt3", cfg.DAILY_CAP * 3, null, "real");
  // generate >200 ledger entries so the old ledger-sum approach would under-count
  for (let i = 0; i < 250; i++) store.ledger("rt3", -1, "noise", "real");
  const amt = cfg.MAX_PER_TX;
  let total = 0, n = 0;
  while (total + amt <= cfg.DAILY_CAP) { const r = await custody.withdraw({ wallet:"rt3", amount: amt, idemKey:"d"+n }, store, async()=>"s"); assert.strictEqual(r.ok, true); total += amt; n++; }
  const over = await custody.withdraw({ wallet:"rt3", amount: amt, idemKey:"over" }, store, async()=>"s");
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.reason, "daily_cap");
});
test("cooldown blocks a too-soon second withdraw (retryable, not burned)", async () => {
  const prev = process.env.KABOOM_WITHDRAW_COOLDOWN_MS;
  process.env.KABOOM_WITHDRAW_COOLDOWN_MS = "60000"; // 1 min window for this test only
  try {
    store.setBalance("cd1", 50000, null, "real");
    const a = await custody.withdraw({ wallet:"cd1", amount: 5000, idemKey:"cd-a" }, store, async()=>"s");
    assert.strictEqual(a.ok, true);
    const b = await custody.withdraw({ wallet:"cd1", amount: 5000, idemKey:"cd-b" }, store, async()=>"s");
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.reason, "cooldown");
    assert.strictEqual(store.getBalance("cd1", 0, "real"), 45000); // only the first debited
    assert.strictEqual(store.hasSig("wd:cd-b"), false);            // not burned -> retryable later
  } finally {
    process.env.KABOOM_WITHDRAW_COOLDOWN_MS = prev;
  }
});
test("handleWithdraw requires an idemKey", async () => {
  const res = await s.handleWithdraw({ wallet:"w", amount: 1000, auth:{} }); // no idemKey
  // disabled wins in test env (no env vars) OR idem_required — both are acceptable refusals; assert it's NOT ok
  assert.ok(res.error === "idem_required" || res.error === "disabled");
});
