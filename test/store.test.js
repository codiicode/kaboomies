const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// isolate persistence to a temp file BEFORE requiring the module
const TMP = path.join(os.tmpdir(), "kaboomies-store-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const store = require("../store");

test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

test("getStats defaults all counters to 0 for unknown keys", () => {
  assert.deepStrictEqual(store.getStats("walletA"),
    { games: 0, kills: 0, deaths: 0, crates: 0, pickups: 0 });
});

test("bumpStat increments a counter for a wallet key", () => {
  store.bumpStat("walletA", "kills");
  store.bumpStat("walletA", "kills", 4);
  store.bumpStat("walletA", "crates", 10);
  const s = store.getStats("walletA");
  assert.strictEqual(s.kills, 5);
  assert.strictEqual(s.crates, 10);
});

test("bumpStat ignores guest keys", () => {
  store.bumpStat("guest:7", "kills", 3);
  assert.strictEqual(store.getStats("guest:7").kills, 0);
});

test("streak getter/setter round-trips and defaults", () => {
  assert.deepStrictEqual(store.getStreak("walletB"), { count: 0, best: 0, day: -1 });
  store.setStreak("walletB", { count: 3, best: 5, day: 42 });
  assert.deepStrictEqual(store.getStreak("walletB"), { count: 3, best: 5, day: 42 });
});

test("getQuestState fresh-resets when the day changes (wallet keys)", () => {
  const q1 = store.getQuestState("walletC", 100);
  q1.prog.kills = 2; q1.done.kills = false;
  store.setQuestState("walletC", q1);
  assert.strictEqual(store.getQuestState("walletC", 100).prog.kills, 2);
  const q2 = store.getQuestState("walletC", 101);   // new day -> reset
  assert.deepStrictEqual(q2.prog, {});
  assert.deepStrictEqual(q2.done, {});
});

test("getQuestState never persists for guest keys", () => {
  const g = store.getQuestState("guest:9", 100);
  g.prog.kills = 5;
  store.setQuestState("guest:9", g);
  assert.deepStrictEqual(store.getQuestState("guest:9", 100).prog, {});
});

test("getWins / getName getters", () => {
  store.bumpWin("walletD", "Dee");
  assert.strictEqual(store.getWins("walletD"), 1);
  assert.strictEqual(store.getName("walletD"), "Dee");
});

test("bot: keys are not wallet keys (never persisted)", () => {
  store.bumpStat("bot:7", "kills", 5);
  assert.strictEqual(store.getStats("bot:7").kills, 0);
  store.setStreak("bot:7", { count: 9, best: 9, day: 1 });
  assert.deepStrictEqual(store.getStreak("bot:7"), { count: 0, best: 0, day: -1 });
});
