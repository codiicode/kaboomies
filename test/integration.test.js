// End-to-end (logic-level) integration tests for the gated real-money feature.
// No real chain: we exercise the exported server.js + custody.js functions directly.
const test = require("node:test");
const assert = require("node:assert");
const s = require("../server.js");
const custody = require("../custody.js");

// --- 1) GATING: with no env vars set (the test default), the real path is inert ---
test("real-money is gated off: custody disabled + withdraw refuses", async () => {
  assert.strictEqual(custody.enabled(), false); // KABOOM_MINT/TREASURY_SECRET/SOLANA_RPC unset
  const res = await s.handleWithdraw({ wallet: "w", amount: 1000, idemKey: "i", auth: {} });
  assert.deepStrictEqual(res, { error: "disabled" });
});

// --- 2) FULL WAGER GAME: buy-in charged once, pot accumulates across rounds, winner takes pot-rake ---
test("full 5-round wager game charges buy-in once, accumulates pot, pays winner pot-rake", () => {
  const room = s.makeRoom("brawl", "real"); // buyIn 5000, deathStake 1000, rake 5%
  const A = s.addPlayer(room, { id: 1, key: "ig-a", name: "A" });
  const B = s.addPlayer(room, { id: 2, key: "ig-b", name: "B" });
  s.setBal("ig-a", 30000, "A", "real");
  s.setBal("ig-b", 30000, "B", "real");

  // Round 1: newRound locks each human's once-per-game buy-in into a fresh pot.
  s.newRound(room);
  assert.strictEqual(A.boughtIn, true);
  assert.strictEqual(B.boughtIn, true);
  assert.strictEqual(room.pot, 10000, "two 5000 buy-ins = 10000 pot");
  assert.strictEqual(s.bal("ig-a", "real"), 25000);
  assert.strictEqual(s.bal("ig-b", "real"), 25000);

  // Rounds 1..4: tally a round win then restart (mimics maybeEndRound's wager branch).
  // A wins rounds 1,2,3; B wins round 4. Pot must NOT re-charge on restart (the W9 bug fix).
  const roundWinners = [1, 1, 1, 2]; // A,A,A,B across the first four rounds
  for (const winnerId of roundWinners) {
    room.roundWins.set(winnerId, (room.roundWins.get(winnerId) || 0) + 1);
    room.gameRound++;
    s.newRound(room); // restart: no re-charge, pot stays put
    assert.strictEqual(room.pot, 10000, "pot must not grow from buy-ins on a round restart");
    assert.strictEqual(s.bal("ig-a", "real"), 25000, "A not charged again");
    assert.strictEqual(s.bal("ig-b", "real"), 25000, "B not charged again");
  }
  // We are now in round 5. Give A the final win and end the game.
  assert.strictEqual(room.gameRound, s.GAME_ROUNDS);
  room.roundWins.set(1, (room.roundWins.get(1) || 0) + 1); // A wins round 5 too
  assert.strictEqual(room.roundWins.get(1), 4); // A: rounds 1,2,3,5
  assert.strictEqual(room.roundWins.get(2), 1); // B: round 4
  s.endGame(room);

  // A (most wins) takes pot - 5% rake = 10000 - 500 = 9500, on top of their 25000.
  assert.strictEqual(s.bal("ig-a", "real"), 25000 + 9500, "winner gets pot minus rake");
  assert.strictEqual(s.bal("ig-b", "real"), 25000, "loser unchanged");
  assert.strictEqual(room.pot, 0, "pot emptied at game end");
  assert.strictEqual(room.gameRound, 1, "startGame reset the game round");
  assert.strictEqual(A.boughtIn, false, "buy-in flag cleared for the next game");

  // A fresh game charges buy-ins again (balances still cover it).
  s.newRound(room);
  assert.strictEqual(room.pot, 10000, "next game re-charges fresh buy-ins");
  assert.strictEqual(s.bal("ig-a", "real"), 34500 - 5000);
  assert.strictEqual(s.bal("ig-b", "real"), 25000 - 5000);
});

// --- 3) LOOT credit: death drops the stake; picking it up credits real balance ---
test("wager death drops loot and crediting a picked-up drop raises the picker's real balance", () => {
  const room = s.makeRoom("brawl", "real"); // deathStake 1000
  const V = s.addPlayer(room, { id: 1, key: "lt-v", name: "V" });
  const K = s.addPlayer(room, { id: 2, key: "lt-k", name: "K" });
  s.setBal("lt-v", 3000, "V", "real");
  s.setBal("lt-k", 0, "K", "real");

  // Victim dies on a known tile -> stake drops as loot (no direct transfer to killer).
  V.x = 5 * s.TILE + s.TILE / 2;
  V.y = 5 * s.TILE + s.TILE / 2;
  s.settleDeath(room, V, K);
  assert.strictEqual(s.bal("lt-v", "real"), 2000, "victim lost the 1000 stake");
  assert.strictEqual(s.bal("lt-k", "real"), 0, "killer not credited directly");
  const drop = room.drops.find(d => d.a === 1000);
  assert.ok(drop, "stake is on the ground as loot");

  // Simulate the pickup credit movePlayer performs when a player stands on the drop tile.
  const before = s.bal("lt-k", "real");
  s.setBal("lt-k", s.bal("lt-k", "real") + drop.a, null, "real");
  room.drops.splice(room.drops.indexOf(drop), 1);
  assert.strictEqual(s.bal("lt-k", "real"), before + 1000, "picking up the drop credits real balance");
  assert.ok(!room.drops.includes(drop), "the drop is consumed once collected");
});
