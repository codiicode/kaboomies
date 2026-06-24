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

// --- W6: 5-round game loop + game-end settlement ---
test("after GAME_ROUNDS the most-round-wins player takes pot minus rake", () => {
  const room = s.makeRoom("brawl", "real");
  const a = s.addPlayer(room, { id: 1, key: "a", name: "A" });
  const b = s.addPlayer(room, { id: 2, key: "b", name: "B" });
  room.pot = 10000; room.roundWins = new Map([[1,3],[2,2]]); room.gameRound = s.GAME_ROUNDS;
  s.setBal("a", 0, "A", "real");
  s.endGame(room);
  assert.strictEqual(s.bal("a", "real"), 9500); // 10000 - 5%
  assert.strictEqual(room.pot, 0);
  assert.strictEqual(room.gameRound, 1);        // startGame reset
});
test("tie splits the pot evenly", () => {
  const room = s.makeRoom("brawl", "real");
  s.addPlayer(room, { id: 1, key: "a", name: "A" }); s.addPlayer(room, { id: 2, key: "b", name: "B" });
  room.pot = 10000; room.roundWins = new Map([[1,2],[2,2]]);
  s.setBal("a", 0, "A", "real"); s.setBal("b", 0, "B", "real");
  s.endGame(room);
  assert.strictEqual(s.bal("a", "real"), 4750);
  assert.strictEqual(s.bal("b", "real"), 4750);
});

// --- W7: sweep uncollected loot into the pot ---
test("uncollected loot is swept into the pot when swept", () => {
  const room = s.makeRoom("brawl", "real");
  s.addPlayer(room, { id: 1, key: "a", name: "A" }); s.addPlayer(room, { id: 2, key: "b", name: "B" });
  room.pot = 5000; room.drops = [{ c: 3, r: 3, a: 700 }, { c: 4, r: 4, a: 300 }];
  s.sweepLoot(room);
  assert.strictEqual(room.pot, 6000);
  assert.strictEqual(room.drops.length, 0);
});

// --- W9: buy-in charged once per game across the real newRound restart path ---
test("buy-in is charged exactly once per game across round restarts (newRound path)", () => {
  const room = s.makeRoom("brawl", "real"); // buyIn 5000
  const a = s.addPlayer(room, { id: 1, key: "ga", name: "A" });
  const b = s.addPlayer(room, { id: 2, key: "gb", name: "B" });
  s.setBal("ga", 30000, "A", "real"); s.setBal("gb", 30000, "B", "real");
  s.newRound(room);                                  // round 1 -> charge once each
  assert.strictEqual(room.pot, 10000);
  assert.strictEqual(s.bal("ga", "real"), 25000);
  assert.strictEqual(s.bal("gb", "real"), 25000);
  s.newRound(room);                                  // round 2 restart -> NO re-charge
  assert.strictEqual(room.pot, 10000, "pot must not grow from buy-ins on round restart");
  assert.strictEqual(s.bal("ga", "real"), 25000, "player must not be charged again");
  s.newRound(room); s.newRound(room);                // rounds 3,4 -> still no re-charge
  assert.strictEqual(room.pot, 10000);
  assert.strictEqual(s.bal("ga", "real"), 25000);
});

test("a new game (after endGame/startGame) charges a fresh buy-in", () => {
  const room = s.makeRoom("brawl", "real");
  const a = s.addPlayer(room, { id: 1, key: "ha", name: "A" });
  const b = s.addPlayer(room, { id: 2, key: "hb", name: "B" });
  s.setBal("ha", 30000, "A", "real"); s.setBal("hb", 30000, "B", "real");
  s.newRound(room);                                  // game 1 buy-ins
  assert.strictEqual(room.pot, 10000);
  room.roundWins = new Map([[1, 3], [2, 2]]); room.gameRound = s.GAME_ROUNDS;
  s.endGame(room);                                   // pays out, pot->0, startGame resets boughtIn
  assert.strictEqual(room.pot, 0);
  s.newRound(room);                                  // game 2 round 1 -> fresh buy-ins
  assert.strictEqual(room.pot, 10000, "next game must charge buy-ins again");
});

// --- W8: snapshot exposes pot/round fields ---
test("snapshot exposes pot, gameRound (gr) and GAME_ROUNDS (gn)", () => {
  const room = s.makeRoom("brawl", "real");
  s.addPlayer(room, { id: 1, key: "a", name: "A" });
  room.pot = 5000; room.gameRound = 2;
  const snap = s.snapshot(room);
  assert.strictEqual(snap.pot, 5000);
  assert.strictEqual(snap.gr, 2);
  assert.strictEqual(snap.gn, s.GAME_ROUNDS);
});
