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
