const test = require("node:test");
const assert = require("node:assert");
const c = require("../characters");

test("hero is always unlocked, even with empty stats", () => {
  assert.strictEqual(c.isUnlocked("hero", {}), true);
  assert.strictEqual(c.DEFAULT_BASE, "hero");
});
test("house unlocks at 3 games", () => {
  assert.strictEqual(c.isUnlocked("house", { games: 2 }), false);
  assert.strictEqual(c.isUnlocked("house", { games: 3 }), true);
});
test("wif unlocks at 100 kills", () => {
  assert.strictEqual(c.isUnlocked("wif", { kills: 99 }), false);
  assert.strictEqual(c.isUnlocked("wif", { kills: 100 }), true);
});
test("mitch uses level", () => {
  assert.strictEqual(c.isUnlocked("mitch", { level: 4 }), false);
  assert.strictEqual(c.isUnlocked("mitch", { level: 5 }), true);
});
test("bull needs 25 wins", () => {
  assert.strictEqual(c.isUnlocked("bull", { wins: 24 }), false);
  assert.strictEqual(c.isUnlocked("bull", { wins: 25 }), true);
});
test("unknown base is never unlocked", () => {
  assert.strictEqual(c.isUnlocked("nope", { kills: 9999, games: 9999 }), false);
  assert.strictEqual(c.isUnlocked(undefined, { kills: 9999 }), false);
});
test("unlockState returns 8 entries, hero first + unlocked, with progress", () => {
  const st = c.unlockState({ games: 3, kills: 100, wins: 0, crates: 0, pickups: 0, level: 1 });
  assert.strictEqual(st.length, 8);
  assert.strictEqual(st[0].base, "hero");
  assert.strictEqual(st[0].unlocked, true);
  const house = st.find(x => x.base === "house");
  assert.strictEqual(house.unlocked, true);
  assert.strictEqual(house.prog, 3);
  const wif = st.find(x => x.base === "wif");
  assert.strictEqual(wif.unlocked, true);
  const bull = st.find(x => x.base === "bull");
  assert.strictEqual(bull.unlocked, false);
  assert.strictEqual(bull.target, 25);
});
