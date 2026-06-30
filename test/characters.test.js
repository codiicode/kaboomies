const test = require("node:test");
const assert = require("node:assert");
const c = require("../characters");

test("hero is always unlocked, even with empty stats", () => {
  assert.strictEqual(c.isUnlocked("hero", {}), true);
  assert.strictEqual(c.DEFAULT_BASE, "hero");
});
test("house unlocks at 10 games", () => {
  assert.strictEqual(c.isUnlocked("house", { games: 9 }), false);
  assert.strictEqual(c.isUnlocked("house", { games: 10 }), true);
});
test("wif unlocks at 300 kills", () => {
  assert.strictEqual(c.isUnlocked("wif", { kills: 299 }), false);
  assert.strictEqual(c.isUnlocked("wif", { kills: 300 }), true);
});
test("mitch needs 100 games", () => {
  assert.strictEqual(c.isUnlocked("mitch", { games: 99 }), false);
  assert.strictEqual(c.isUnlocked("mitch", { games: 100 }), true);
});
test("alon needs 1000 kills", () => {
  assert.strictEqual(c.isUnlocked("alon", { kills: 999 }), false);
  assert.strictEqual(c.isUnlocked("alon", { kills: 1000 }), true);
});
test("bull needs 75 wins", () => {
  assert.strictEqual(c.isUnlocked("bull", { wins: 74 }), false);
  assert.strictEqual(c.isUnlocked("bull", { wins: 75 }), true);
});
test("unknown base is never unlocked", () => {
  assert.strictEqual(c.isUnlocked("nope", { kills: 9999, games: 9999 }), false);
  assert.strictEqual(c.isUnlocked(undefined, { kills: 9999 }), false);
});
test("earl is a starter — always unlocked, even with empty stats", () => {
  assert.strictEqual(c.isUnlocked("earl", {}), true);
});
test("unlockState returns 9 entries, hero+earl first + unlocked, with progress", () => {
  const st = c.unlockState({ games: 10, kills: 300, wins: 0, crates: 0, pickups: 0, level: 1 });
  assert.strictEqual(st.length, 9);
  assert.strictEqual(st[0].base, "hero");
  assert.strictEqual(st[0].unlocked, true);
  assert.strictEqual(st[1].base, "earl");
  assert.strictEqual(st[1].unlocked, true);
  const house = st.find(x => x.base === "house");
  assert.strictEqual(house.unlocked, true);
  assert.strictEqual(house.prog, 10);
  const wif = st.find(x => x.base === "wif");
  assert.strictEqual(wif.unlocked, true);
  const bull = st.find(x => x.base === "bull");
  assert.strictEqual(bull.unlocked, false);
  assert.strictEqual(bull.target, 75);
});
