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
