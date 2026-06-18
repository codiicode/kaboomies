const test = require("node:test");
const assert = require("node:assert");
const os = require("os"); const path = require("path"); const fs = require("fs");
const TMP = path.join(os.tmpdir(), "kaboomies-econ-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const game = require("../server");
const store = game.store;
test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

function room(stake) {
  const players = new Map();
  players.set(1, { id: 1, key: "h1" });
  players.set(2, { id: 2, key: "h2" });
  return { deathDrop: stake, cur: "play", players };
}

test("settleDeath transfers the stake from victim to killer", () => {
  store.setBalance("ecK", 50, "K", "play"); store.setBalance("ecV", 250, "V", "play");
  const killer = { id: 1, key: "ecK", name: "K", alive: true };
  const victim = { id: 2, key: "ecV", name: "V", alive: false, streak: 3 };
  game.settleDeath(room(100), victim, killer);
  assert.strictEqual(game.bal("ecV", "play"), 150);
  assert.strictEqual(game.bal("ecK", "play"), 150);
  assert.strictEqual(victim.streak, 0);
});
test("settleDeath caps the transfer at the victim's balance", () => {
  store.setBalance("ecK2", 0, "K", "play"); store.setBalance("ecV2", 30, "V", "play");
  game.settleDeath(room(100), { id: 2, key: "ecV2", name: "V", alive: false }, { id: 1, key: "ecK2", name: "K", alive: true });
  assert.strictEqual(game.bal("ecV2", "play"), 0);
  assert.strictEqual(game.bal("ecK2", "play"), 30);
});
test("self/environment death burns the stake (no recipient)", () => {
  store.setBalance("ecV3", 200, "V", "play");
  game.settleDeath(room(100), { id: 2, key: "ecV3", name: "V", alive: false }, null);
  assert.strictEqual(game.bal("ecV3", "play"), 100);
});
test("a dead killer (mutual kill) does not earn", () => {
  store.setBalance("ecK4", 100, "K", "play"); store.setBalance("ecV4", 100, "V", "play");
  game.settleDeath(room(100), { id: 2, key: "ecV4", name: "V", alive: false }, { id: 1, key: "ecK4", name: "K", alive: false });
  assert.strictEqual(game.bal("ecV4", "play"), 0);
  assert.strictEqual(game.bal("ecK4", "play"), 100);
});

function rankedRoom(stake, humans){ const players=new Map();
  for(let i=0;i<humans;i++) players.set(i+1,{id:i+1,key:"w"+i});
  return { deathDrop:stake, cur:"play", players }; }

test("settleDeath moves balances only in a ranked room (>=2 humans)", () => {
  store.setBalance("rkK",50,"K","play"); store.setBalance("rkV",250,"V","play");
  const solo=rankedRoom(100,1); // 1 human => not ranked
  game.settleDeath(solo, {id:9,key:"rkV",name:"V",alive:false}, {id:8,key:"rkK",name:"K",alive:true});
  assert.strictEqual(game.bal("rkV","play"),250); // unchanged (practice)
  assert.strictEqual(game.bal("rkK","play"),50);
  const ranked=rankedRoom(100,2);
  game.settleDeath(ranked, {id:9,key:"rkV",name:"V",alive:false}, {id:8,key:"rkK",name:"K",alive:true});
  assert.strictEqual(game.bal("rkV","play"),150); // transferred
  assert.strictEqual(game.bal("rkK","play"),150);
});
