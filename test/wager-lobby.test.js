const test = require("node:test");
const assert = require("node:assert");
const s = require("../server.js");

// helper: add a bare human player to a room
function add(room, id, key, name) { return s.addPlayer(room, { id, key, name }); }

test("a wager room opens in the lobby (waiting); sitting alone costs nothing", () => {
  const room = s.makeRoom("casual", "real");          // buyIn 500
  assert.strictEqual(room.phase, "waiting");
  const a = add(room, 1, "LB1", "A");
  s.setBal("LB1", 5000, "A", "real");
  s.tick(room, 16);                                    // only 1 human -> stays waiting
  assert.strictEqual(room.phase, "waiting");
  assert.strictEqual(a.paid, 0);
  assert.strictEqual(s.bal("LB1", "real"), 5000, "never charged while alone in the lobby");
});

test(">=2 players -> countdown -> charged only at game start", () => {
  const room = s.makeRoom("casual", "real");
  add(room, 1, "LB2a", "A"); add(room, 2, "LB2b", "B");
  s.setBal("LB2a", 5000, "A", "real"); s.setBal("LB2b", 5000, "B", "real");
  s.tick(room, 16);                                    // 2 humans -> countdown begins
  assert.strictEqual(room.phase, "countdown");
  assert.strictEqual(s.bal("LB2a", "real"), 5000, "NOT charged during the countdown");
  s.tick(room, s.LOBBY_COUNTDOWN_MS + 100);            // countdown elapses -> start + charge
  assert.strictEqual(room.phase, "playing");
  assert.strictEqual(room.pot, 1000, "two 500 buy-ins locked into the pot");
  assert.strictEqual(s.bal("LB2a", "real"), 4500);
  assert.strictEqual(s.bal("LB2b", "real"), 4500);
});

test("countdown cancels (no charge) if it drops back below the minimum", () => {
  const room = s.makeRoom("casual", "real");
  add(room, 1, "LB3a", "A"); add(room, 2, "LB3b", "B");
  s.setBal("LB3a", 5000, "A", "real"); s.setBal("LB3b", 5000, "B", "real");
  s.tick(room, 16);
  assert.strictEqual(room.phase, "countdown");
  room.players.delete(2);                              // B leaves before it fires
  s.tick(room, 16);
  assert.strictEqual(room.phase, "waiting");
  assert.strictEqual(s.bal("LB3a", "real"), 5000, "nobody was charged");
});

test("a player who can't cover the buy-in sits out (spectates), not charged", () => {
  const room = s.makeRoom("casual", "real");
  add(room, 1, "LB4a", "A"); const poor = add(room, 2, "LB4b", "B"); add(room, 3, "LB4c", "C");
  s.setBal("LB4a", 5000, "A", "real"); s.setBal("LB4b", 100, "B", "real"); s.setBal("LB4c", 5000, "C", "real");
  s.tick(room, 16); s.tick(room, s.LOBBY_COUNTDOWN_MS + 100);
  assert.strictEqual(room.phase, "playing");
  assert.strictEqual(room.pot, 1000, "only the two solvent players paid");
  assert.strictEqual(poor.spectating, true);
  assert.strictEqual(poor.alive, false);
  assert.strictEqual(s.bal("LB4b", "real"), 100, "the broke player is never charged");
});

test("ABANDON: a live game dropping below the minimum refunds those still present, no rake", () => {
  const room = s.makeRoom("highroller", "real");       // buyIn 50000
  const a = add(room, 1, "LB5a", "A"); add(room, 2, "LB5b", "B");
  s.setBal("LB5a", 60000, "A", "real"); s.setBal("LB5b", 60000, "B", "real");
  s.tick(room, 16); s.tick(room, s.LOBBY_COUNTDOWN_MS + 100);
  assert.strictEqual(room.phase, "playing");
  assert.strictEqual(room.pot, 100000);
  assert.strictEqual(s.bal("LB5a", "real"), 10000);
  room.players.delete(2);                              // B leaves mid-game
  s.abandonWagerGame(room);                            // (what the close handler calls)
  assert.strictEqual(s.bal("LB5a", "real"), 60000, "A is fully refunded their buy-in");
  assert.strictEqual(room.pot, 0, "pot cleared");
  assert.strictEqual(room.phase, "waiting", "back to the lobby");
  assert.strictEqual(a.paid, 0);
});

test("training (play) rooms are unaffected: they start playing immediately, no lobby", () => {
  const room = s.makeRoom("brawl", "play");
  assert.strictEqual(room.phase, "playing");
  const a = add(room, 1, "LB6", "A");
  s.tick(room, 16);
  assert.strictEqual(room.phase, "playing");           // no waiting/countdown for free play
  assert.strictEqual(a.paid, 0);
});
