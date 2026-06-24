const test = require("node:test");
const assert = require("node:assert");
const s = require("../server.js");

test("a real-money room starts a game: round 1 of GAME_ROUNDS, empty round-wins", () => {
  const room = s.makeRoom("brawl", "real");
  assert.strictEqual(room.cur, "real");
  assert.strictEqual(room.gameRound, 1);
  assert.strictEqual(s.GAME_ROUNDS, 5);
  assert.strictEqual(room.roundWins instanceof Map, true);
  assert.strictEqual(room.roundWins.size, 0);
});

test("isWagerGame is true only for real-currency wager maps", () => {
  assert.strictEqual(s.isWagerGame(s.makeRoom("brawl", "real")), true);
  assert.strictEqual(s.isWagerGame(s.makeRoom("brawl", "play")), false);
});

test("training (play mode) on a wager map is NOT a wager game", () => {
  for (const id of ["casual", "brawl", "highroller"]) {
    assert.strictEqual(s.isWagerGame(s.makeRoom(id, "play")), false, id + " play must not be wager");
    assert.strictEqual(s.isWagerGame(s.makeRoom(id, "real")), true, id + " real must be wager");
  }
});

test("buy-in is charged once per game and locked into the pot", () => {
  const room = s.makeRoom("brawl", "real");            // buyIn 5000
  const p = s.addPlayer(room, { id: 1, key: "w1", name: "A" });
  s.setBal("w1", 12000, "A", "real");
  s.chargeBuyIn(room, p);
  assert.strictEqual(s.bal("w1", "real"), 7000);       // 12000 - 5000
  assert.strictEqual(room.pot, 5000);
  assert.strictEqual(p.boughtIn, true);
  s.chargeBuyIn(room, p);                              // again = no-op
  assert.strictEqual(room.pot, 5000);
  assert.strictEqual(s.bal("w1", "real"), 7000);
});
test("chargeBuyIn does nothing in a training (play) room", () => {
  const room = s.makeRoom("brawl", "play");
  const p = s.addPlayer(room, { id: 1, key: "t1", name: "T" });
  s.setBal("t1", 12000, "T", "play");
  s.chargeBuyIn(room, p);
  assert.strictEqual(room.pot, 0);
  assert.ok(!p.boughtIn);
});

test("in a wager game, death drops the stake as loot (not a direct transfer)", () => {
  const room = s.makeRoom("brawl", "real");            // deathStake 1000
  const v = s.addPlayer(room, { id: 1, key: "v", name: "V" });
  const k = s.addPlayer(room, { id: 2, key: "k", name: "K" });
  s.setBal("v", 3000, "V", "real");
  s.setBal("k", 0, "K", "real");
  v.x = 5 * s.TILE + s.TILE / 2; v.y = 5 * s.TILE + s.TILE / 2;
  s.settleDeath(room, v, k);
  assert.strictEqual(s.bal("v", "real"), 2000);        // victim lost 1000
  assert.strictEqual(s.bal("k", "real"), 0);           // killer did NOT get it directly
  assert.ok(room.drops.some(d => d.a === 1000));       // it's on the ground as loot
});
