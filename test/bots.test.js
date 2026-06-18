const test = require("node:test");
const assert = require("node:assert");
const os=require("os"),path=require("path"),fs=require("fs");
process.env.KABOOM_DATA = path.join(os.tmpdir(),"kaboomies-bots-test-"+process.pid+".json");
const game = require("../server");
test.after(()=>{ try{fs.unlinkSync(process.env.KABOOM_DATA);}catch(e){} });

function room(){ // 5x5: walls border, empty interior, one crate at (2,1)
  const cols=5,rows=5,grid=[];
  for(let r=0;r<rows;r++){grid.push([]);for(let c=0;c<cols;c++)grid[r].push((r===0||c===0||r===rows-1||c===cols-1)?1:0);}
  grid[1][2]=2;
  return {cols,rows,grid,bombs:[],players:new Map()};
}

test("botWalkable: empty interior tile yes, wall/crate/bomb no", () => {
  const rm=room();
  assert.strictEqual(game.botWalkable(rm,1,1),true);
  assert.strictEqual(game.botWalkable(rm,0,0),false);   // wall
  assert.strictEqual(game.botWalkable(rm,2,1),false);   // crate
  rm.bombs.push({col:1,row:1,range:2});
  assert.strictEqual(game.botWalkable(rm,1,1),false);   // bomb on tile
});

test("botBlastCells: stops at walls, includes one crate then stops", () => {
  const rm=room();
  const cells=game.botBlastCells(rm,1,1,3);
  assert.ok(cells.has("1,1"));      // origin
  assert.ok(cells.has("2,1"));      // crate tile included
  assert.ok(!cells.has("3,1"));     // blocked beyond the crate
  assert.ok(!cells.has("1,0"));     // border wall not included
});

test("botDangerSet: unions blast cells of all bombs", () => {
  const rm=room(); rm.bombs.push({col:1,row:1,range:1});
  const d=game.botDangerSet(rm);
  assert.ok(d.has("1,1")&&d.has("1,2")&&d.has("2,1"));
});

test("humanCount/isRanked count non-bot players", () => {
  const rm=room();
  rm.players.set(1,{id:1});                 // human
  rm.players.set(2,{id:2,bot:true});        // bot
  assert.strictEqual(game.humanCount(rm),1);
  assert.strictEqual(game.isRanked(rm),false);
  rm.players.set(3,{id:3});
  assert.strictEqual(game.humanCount(rm),2);
  assert.strictEqual(game.isRanked(rm),true);
});

test("botTarget: fill to 4 minus humans, never negative", () => {
  assert.strictEqual(game.botTarget(1),3);
  assert.strictEqual(game.botTarget(2),2);
  assert.strictEqual(game.botTarget(4),0);
  assert.strictEqual(game.botTarget(6),0);
});

test("broadcast skips bots (stub ws, no send) and never throws", () => {
  let humanGot = null;
  const human = { id: 1, ws: { readyState: 1, send: (s) => { humanGot = s; } } };
  const bot = { id: 2, bot: true, ws: { readyState: 3 } }; // stub ws, no send()
  const closed = { id: 3, ws: { readyState: 3, send: () => { throw new Error("should not send to closed"); } } };
  const rm = { players: new Map([[1, human], [2, bot], [3, closed]]) };
  assert.doesNotThrow(() => game.broadcast(rm, { t: "round", x: 1 }));
  assert.strictEqual(humanGot, JSON.stringify({ t: "round", x: 1 })); // human received it
});

test("rateAllow: allows a burst, blocks when drained, refills over time", () => {
  const st = { tokens: 50, last: 1000, over: 0 };
  let allowed = 0;
  for (let i = 0; i < 50; i++) if (game.rateAllow(st, 1000, 30, 50)) allowed++; // same instant: no refill
  assert.strictEqual(allowed, 50);                              // full burst passes
  assert.strictEqual(game.rateAllow(st, 1000, 30, 50), false);  // drained -> blocked
  assert.ok(st.over >= 1);                                      // tracks consecutive blocks
  assert.strictEqual(game.rateAllow(st, 2000, 30, 50), true);   // ~1s later refills ~30 tokens
  assert.strictEqual(st.over, 0);                               // reset on allow
});
