const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "kaboomies-profile-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const game = require("../server");
const store = game.store;

test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

test("buildProfile returns level, stats, streak and 3 quests", () => {
  store.bumpStat("walletP", "kills", 7);
  store.bumpStat("walletP", "deaths", 2);
  store.bumpStat("walletP", "games", 4);
  store.bumpWin("walletP", "Pat");
  const p = game.buildProfile("walletP", "Pat");
  assert.strictEqual(p.stats.kills, 7);
  assert.strictEqual(p.stats.deaths, 2);
  assert.strictEqual(p.stats.games, 4);
  assert.strictEqual(p.stats.wins, 1);
  assert.strictEqual(p.stats.winRate, 25);          // 1/4
  assert.strictEqual(p.stats.kd, 3.5);              // 7/2
  assert.ok(p.level >= 1);
  assert.strictEqual(p.quests.length, 3);
  assert.ok("count" in p.streak && "best" in p.streak);
});

test("buildProfile K/D with zero deaths equals kills", () => {
  store.bumpStat("walletQ", "kills", 5);
  const p = game.buildProfile("walletQ", null);
  assert.strictEqual(p.stats.kd, 5);
});
