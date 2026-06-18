# Bots Fill Empty Rooms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Server-side AI bots fill training rooms to 4 players, fade out as humans join, and a "ranked" gate (≥2 humans) keeps bot practice out of the economy/stats/quests/leaderboard (XP still granted).

**Architecture:** Bots are ephemeral player objects in `room.players` driven by a server port of the client `botThink` AI inside the existing `tick` loop. A lifecycle (`syncBots`) keeps headcount right. An `isRanked(room)` gate wraps the persistence/economy hooks. `store.isWalletKey` excludes `bot:` keys so bots never persist.

**Tech stack:** Node `node --test`, `ws`. No new deps. Client largely unchanged.

**Spec:** `docs/superpowers/specs/2026-06-18-bots-fill-rooms-design.md`

---

## Task Bot-1: `store.isWalletKey` excludes bot keys (TDD)

**Files:** Modify `store.js`; Test: extend `test/store.test.js`.

- [ ] **Step 1: Failing test** — append to `test/store.test.js`:
```js
test("bot: keys are not wallet keys (never persisted)", () => {
  store.bumpStat("bot:7", "kills", 5);
  assert.strictEqual(store.getStats("bot:7").kills, 0);
  store.setStreak("bot:7", { count: 9, best: 9, day: 1 });
  assert.deepStrictEqual(store.getStreak("bot:7"), { count: 0, best: 0, day: -1 });
});
```
- [ ] **Step 2:** `npm test` → fails (bot stats persist).
- [ ] **Step 3:** In `store.js`, change `isWalletKey`:
```js
function isWalletKey(key) { return !!key && !key.startsWith("guest:") && !key.startsWith("bot:"); }
```
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `git add store.js test/store.test.js && git commit -m "feat: store treats bot: keys as ephemeral (never persisted)"`

---

## Task Bot-2: AI helpers + humanCount/isRanked + bot headcount (TDD)

**Files:** Modify `server.js` (add helpers + exports); Test: create `test/bots.test.js`.

> Constants available: `TILE`. Room shape: `room.grid[r][c]` (0 empty,1 wall,2 crate), `room.bombs` (each `{col,row,range,...}`), `room.players` (Map id→player), `room.cols`, `room.rows`. `MAX_PLAYERS` exists.

- [ ] **Step 1: Failing test** — `test/bots.test.js`:
```js
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
```
- [ ] **Step 2:** `npm test` → the bots suite fails (helpers undefined).
- [ ] **Step 3:** Add helpers in `server.js` (near the other room helpers, before `module.exports`):
```js
// ---- bots: AI helpers + headcount (training rooms only; bots are ephemeral) ----
const BOT_TARGET = 4; // desired total players in a room while a human is present
function humanCount(room) { let n = 0; for (const p of room.players.values()) if (!p.bot) n++; return n; }
function isRanked(room) { return humanCount(room) >= 2; } // <2 humans = practice (XP only)
function botTarget(humans) { return Math.max(0, Math.min(BOT_TARGET - humans, MAX_PLAYERS - humans)); }

function botWalkable(room, c, r) {
  return c >= 0 && r >= 0 && c < room.cols && r < room.rows &&
    room.grid[r][c] === 0 && !room.bombs.some(b => b.col === c && b.row === r);
}
function botBlastCells(room, c, r, range) {
  const s = new Set([c + "," + r]);
  for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    for (let i = 1; i <= range; i++) {
      const nc = c + dc * i, nr = r + dr * i;
      if (nc < 0 || nr < 0 || nc >= room.cols || nr >= room.rows) break;
      const t = room.grid[nr][nc];
      if (t === 1) break;            // wall blocks
      s.add(nc + "," + nr);
      if (t === 2) break;            // crate absorbs the rest
    }
  }
  return s;
}
function botDangerSet(room) {
  const s = new Set();
  for (const b of room.bombs) for (const k of botBlastCells(room, b.col, b.row, b.range)) s.add(k);
  return s;
}
```
- [ ] **Step 4:** Add `humanCount, isRanked, botTarget, botWalkable, botBlastCells, botDangerSet` to `module.exports`.
- [ ] **Step 5:** `npm test` → all pass. `node --check server.js`.
- [ ] **Step 6:** Commit `git add server.js test/bots.test.js && git commit -m "feat: bot AI helpers + humanCount/isRanked/botTarget"`

---

## Task Bot-3: ranked gate on the economy/stat hooks (TDD)

**Files:** Modify `server.js`; Test: extend `test/economy.test.js`.

> Apply `isRanked(room)` so solo+bots is practice (XP only). Also guard bots out of XP/balance entirely.

- [ ] **Step 1: Failing test** — append to `test/economy.test.js`:
```js
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
```
- [ ] **Step 2:** `npm test` → new test fails (solo room still transfers).
- [ ] **Step 3:** Gate `settleDeath` — change its body so the transfer only runs when ranked:
```js
function settleDeath(room, victim, killer) {
  victim.streak = 0;
  if (!isRanked(room)) return;                 // practice (solo + bots): no chips move
  const stake = room.deathDrop != null ? room.deathDrop : DEATH_DROP;
  const lost = Math.min(stake, bal(victim.key, room.cur));
  if (lost <= 0) return;
  setBal(victim.key, bal(victim.key, room.cur) - lost, victim.name, room.cur);
  if (killer && killer.id !== victim.id && killer.alive)
    setBal(killer.key, bal(killer.key, room.cur) + lost, killer.name, room.cur);
}
```
- [ ] **Step 4:** Gate the other hooks. In each, keep `gainXp(...)` for humans always, but wrap the `store.bumpStat`/`bumpQuest`/`bumpWin`/games/pot in `if (isRanked(room)) { ... }`, and guard bots out of XP/balance:
  - **kill hook**: the kill-credit `if (killer && killer.id !== pl.id && killer.alive)` block — only call `gainXp`/`store.bumpStat("kills")`/`bumpQuest` when `!killer.bot`; and wrap the `store.bumpStat`+`bumpQuest` in `if (isRanked(room))`. Keep `gainXp` outside the ranked check (always, humans).
  - **death hook** `store.bumpStat(pl.key,"deaths")`: wrap in `if (isRanked(room) && !pl.bot)`.
  - **crate hook**: `gainXp(room, ownerKey, XP_CRATE)` only if the owner is human (guard `ownerPlayer && !ownerPlayer.bot`); `store.bumpStat(ownerKey,"crates")`+`bumpQuest` only when `isRanked(room)`.
  - **pickup hook**: `gainXp(XP_PICKUP)` only if `!pl.bot`; `bumpStat(pickups)`+`bumpQuest` only when `isRanked(room)`.
  - **maybeEndRound / win**: wrap `w.wins++`, pot/payout, `store.bumpWin`, the `games` `bumpStat` loop and its `bumpQuest` in `if (isRanked(room))`. Keep `gainXp(room, w.key, XP_WIN)` for a human winner always (guard `!w.bot`). Bots get nothing.
  Use the variable names already in those blocks (`pl`, `killer`, `ownerKey`/`ownerPlayer`, `w`, `pp`).
- [ ] **Step 5:** `npm test` → all pass (existing 2-human economy still works; solo no longer transfers). `node --check server.js`.
- [ ] **Step 6:** Commit `git add server.js test/economy.test.js && git commit -m "feat: ranked gate (>=2 humans) on economy/stats/quests/wins; bots earn nothing"`

---

## Task Bot-4: bot factory + lifecycle (syncBots, join/leave/round, drop-on-last-human)

**Files:** Modify `server.js`.

> No new unit test (room/WS lifecycle); verified by Bot-6's integration test + preview.

- [ ] **Step 1: Bot factory + name pool** — add near the bot helpers (these live inside `startServer` if they need `nextId`, OR pass an id). Since `nextId` is in the `startServer` scope and the join handler is too, place `makeBot`/`syncBots` inside `startServer` (near `roomFor`). Add:
```js
  const BOT_NAMES = ["Sparky","Boomer","Dyna","Pixel","Fuse","Blanka","Volt","Nitro","Pop","Tnt"];
  const BOT_LOOKS = [["hero","#e8b07a","#ff5d73"],["house","#e8b07a","#54b8ff"],["hero","#e8b07a","#a06bff"],
    ["house","#e8b07a","#43d17f"],["hero","#e8b07a","#ffb03a"],["popcat","#e8b07a","#ff5dd8"],["alon","#e8b07a","#37d6ff"]];
  function botName(room){ const used=new Set([...room.players.values()].map(p=>p.name));
    const free=BOT_NAMES.filter(n=>!used.has(n)); return (free.length?free:BOT_NAMES)[Math.floor(Math.random()*(free.length?free.length:BOT_NAMES.length))]; }
  function makeBot(room){
    const id=nextId++; const look=BOT_LOOKS[Math.floor(Math.random()*BOT_LOOKS.length)];
    const bot={ id, ws:{readyState:3}, key:"bot:"+id, wallet:null, verified:false, voice:false, bot:true,
      name:botName(room), base:look[0], skin:look[1], clothes:look[2] };
    addPlayer(room, bot); return bot;
  }
  function syncBots(room){
    if (MAPS[room.mapId] && MAPS[room.mapId].wager) return;   // never in wager/real rooms
    const humans = humanCount(room);
    const bots = [...room.players.values()].filter(p=>p.bot);
    if (humans === 0) { for (const b of bots) room.players.delete(b.id); return; } // let the room drop
    const want = botTarget(humans);
    if (bots.length < want) { for (let i=bots.length; i<want; i++) makeBot(room); }
    else if (bots.length > want) {
      const dead = bots.filter(b=>!b.alive); const live = bots.filter(b=>b.alive);
      let remove = bots.length - want;
      for (const b of dead) { if (remove<=0) break; room.players.delete(b.id); remove--; }
      // only trim live bots between rounds (room not mid-playing) to avoid disrupting a round
      if (room.phase !== "playing") for (const b of live) { if (remove<=0) break; room.players.delete(b.id); remove--; }
    }
  }
```
  (Note: `addPlayer` sets the spawn + `resetPlayer`; ensure `resetPlayer` initializes `p.ai` — see Bot-5 Step 1. `ws:{readyState:3}` makes every `p.ws.send` guard skip the bot.)
- [ ] **Step 2: Call syncBots on join** — in the join handler, after `addPlayer(room, player);` (the human), add `syncBots(room);`.
- [ ] **Step 3: Call syncBots + fix drop on disconnect** — in the `ws.on("close")` handler, where it currently does `room.players.delete(player.id); if (room.players.size === 0) {...dropRoom...}`, change to:
```js
        room.players.delete(player.id);
        syncBots(room); // remove bots if that was the last human
        if (humanCount(room) === 0) { clearTimeout(room.roundTimer); for (const b of [...room.players.values()]) room.players.delete(b.id); dropRoom(room); }
```
- [ ] **Step 4: Re-balance at round start** — in `newRound(room)`, after players are reset, add `syncBots(room);` (so surplus live bots are trimmed and shortfalls filled between rounds). If `syncBots`/`makeBot` are defined inside `startServer` but `newRound` is module-scope, that's a scope problem — see note. **Scope note:** `newRound` is a module-scope function but `syncBots` needs `nextId`/`addPlayer` (module-scope `addPlayer` exists; `nextId` is in startServer). To keep it simple, define `makeBot`/`syncBots` at MODULE scope and pass an id source: use a module-scope `let botSeq = 1e6;` for bot ids (kept well above human `nextId` to avoid collisions) instead of `nextId`. Then `newRound` can call `syncBots(room)` too. Update Step 1 to use `botSeq++` and move `makeBot`/`syncBots`/`botName`/`BOT_NAMES`/`BOT_LOOKS` to module scope (next to the other room helpers). The join/close handlers (in startServer) can still call the module-scope `syncBots`.
- [ ] **Step 5:** `node --check server.js`; `npm test` (still green — no behavior tested here yet).
- [ ] **Step 6:** Commit `git add server.js && git commit -m "feat: bot lifecycle — fill to target, fade out, drop room on last human leave"`

---

## Task Bot-5: bot AI (botThink) + tick driving

**Files:** Modify `server.js`.

> Port the client `botThink` (in public/index.html) to operate on `room`. Reference (client) logic to adapt:
> flee if centered & in danger → else bomb if (adjacent crate OR enemy within range+1) with an escape tile → else wander/chase nearest alive player; then set `bot.in` toward the target tile.

- [ ] **Step 1: Init AI state on spawn** — in `resetPlayer(p, sp)` (module scope), add at the end: `p.ai = { tc: Math.round((p.x - TILE/2)/TILE), tr: Math.round((p.y - TILE/2)/TILE), flee: false };` (so bots have a target tile; harmless for humans).
- [ ] **Step 2: Implement `botThink(room, bot)`** (module scope, near the bot helpers):
```js
function botThink(room, bot) {
  const c = Math.round((bot.x - TILE/2)/TILE), r = Math.round((bot.y - TILE/2)/TILE);
  const cx = c*TILE + TILE/2, cy = r*TILE + TILE/2;
  const centered = Math.abs(bot.x - cx) < 3 && Math.abs(bot.y - cy) < 3;
  const danger = botDangerSet(room);
  const players = [...room.players.values()];
  if (centered) {
    bot.x = cx; bot.y = cy;
    if (danger.has(c + "," + r)) {
      const safe = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].filter(([nc,nr]) => botWalkable(room,nc,nr) && !danger.has(nc+","+nr));
      bot.ai.tc = safe.length ? safe[0][0] : c; bot.ai.tr = safe.length ? safe[0][1] : r; bot.ai.flee = true;
    } else {
      bot.ai.flee = false;
      const adjCrate = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].some(([nc,nr]) => nr>=0&&nc>=0&&nr<room.rows&&nc<room.cols&&room.grid[nr][nc]===2);
      let ed = 99; for (const q of players){ if (q===bot||!q.alive) continue; const qc=Math.round((q.x-TILE/2)/TILE),qr=Math.round((q.y-TILE/2)/TILE); ed=Math.min(ed,Math.abs(qc-c)+Math.abs(qr-r)); }
      const canBomb = room.bombs.filter(b=>b.owner===bot.id).length < bot.maxBombs && room.grid[r][c]===0 && !room.bombs.some(b=>b.col===c&&b.row===r);
      if (canBomb && (adjCrate || ed <= bot.range+1) && Math.random() < 0.85) {
        const blast = botBlastCells(room, c, r, bot.range);
        const esc = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].find(([nc,nr]) => botWalkable(room,nc,nr) && !blast.has(nc+","+nr));
        if (esc) { placeBomb(room, bot); bot.ai.tc=esc[0]; bot.ai.tr=esc[1]; bot.ai.flee=true; }
        else if (ed <= 1) { placeBomb(room, bot); const any=[[c+1,r],[c-1,r],[c,r+1],[c,r-1]].find(([nc,nr])=>botWalkable(room,nc,nr)); if(any){bot.ai.tc=any[0];bot.ai.tr=any[1];bot.ai.flee=true;}else{bot.ai.tc=c;bot.ai.tr=r;} }
        else { bot.ai.tc=c; bot.ai.tr=r; }
      } else {
        let opts = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].filter(([nc,nr]) => botWalkable(room,nc,nr) && !danger.has(nc+","+nr));
        if (!opts.length) opts = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].filter(([nc,nr]) => botWalkable(room,nc,nr));
        if (opts.length) {
          let tgt=null,best=1e9; for (const q of players){ if(q===bot||!q.alive)continue; const qc=Math.round((q.x-TILE/2)/TILE),qr=Math.round((q.y-TILE/2)/TILE); const d=Math.abs(qc-c)+Math.abs(qr-r); if(d<best){best=d;tgt=[qc,qr];} }
          if (tgt && Math.random() < 0.8) { opts.sort((a,b)=>(Math.abs(a[0]-tgt[0])+Math.abs(a[1]-tgt[1]))-(Math.abs(b[0]-tgt[0])+Math.abs(b[1]-tgt[1]))); bot.ai.tc=opts[0][0]; bot.ai.tr=opts[0][1]; }
          else { const pick=opts[Math.floor(Math.random()*opts.length)]; bot.ai.tc=pick[0]; bot.ai.tr=pick[1]; }
        } else { bot.ai.tc=c; bot.ai.tr=r; }
      }
    }
  }
  const tx = bot.ai.tc*TILE + TILE/2, ty = bot.ai.tr*TILE + TILE/2;
  bot.in = { l: bot.x > tx+1, r: bot.x < tx-1, u: bot.y > ty+1, d: bot.y < ty-1 };
}
```
- [ ] **Step 3: Drive bots in `tick`** — at the start of `tick(room, dt)`, before the movement loop, add:
```js
  if (room.phase === "playing") for (const p of room.players.values()) if (p.bot && p.alive && p.ai) botThink(room, p);
```
  (The existing movement loop then consumes `p.in` for everyone.)
- [ ] **Step 4:** `node --check server.js`; `npm test` (green).
- [ ] **Step 5:** Commit `git add server.js && git commit -m "feat: server-side bot AI (botThink) driven in the game loop"`

---

## Task Bot-6: integration test + preview verify + deploy

**Files:** Test: `test/bots-live.test.js` (integration); then verify + ship.

- [ ] **Step 1: Behavioral integration test** — `test/bots-live.test.js`: start the server on an ephemeral port, connect ONE ws client, join "brawl" play mode, and assert that within ~2s the snapshot shows ≥2 players (bots filled in) and the phase becomes "playing".
```js
const test=require("node:test"); const assert=require("node:assert");
const os=require("os"),path=require("path"),fs=require("fs"); const WebSocket=require("ws");
process.env.KABOOM_DATA=path.join(os.tmpdir(),"kaboomies-botslive-"+process.pid+".json");
const game=require("../server");
test.after(()=>{try{fs.unlinkSync(process.env.KABOOM_DATA);}catch(e){}});

test("a solo human joining a training room gets bots and a live round", async () => {
  const server=game.startServer(0); await new Promise(r=>server.once("listening",r));
  const port=server.address().port;
  const ws=new WebSocket("ws://127.0.0.1:"+port);
  const seen={max:0,playing:false};
  ws.on("open",()=>ws.send(JSON.stringify({t:"join",name:"Solo",base:"hero",skin:"#e8b07a",clothes:"#fff",map:"brawl",mode:"play"})));
  ws.on("message",raw=>{const m=JSON.parse(raw); if(m.t==="s"){ seen.max=Math.max(seen.max,m.players.length); if(m.ph==="playing")seen.playing=true; }});
  await new Promise(r=>setTimeout(r,2500));
  ws.close(); await new Promise(r=>server.close(r));
  assert.ok(seen.max>=2, "expected bots to fill the room, saw max "+seen.max+" players");
  assert.ok(seen.playing, "expected the round to be playing");
});
```
- [ ] **Step 2:** `npm test` → all suites pass incl. this one. `node --check server.js`.
- [ ] **Step 3: Commit** `git add test/bots-live.test.js && git commit -m "test: integration — solo join fills with bots and starts a round"`
- [ ] **Step 4: Preview** — start the server, join a brawl room solo (preview_eval `joinMap('brawl')`), wait, screenshot/snapshot: confirm bots appear and move and the round plays. Confirm the balance does NOT change solo (practice). Confirm the offline `startLocal` path still works (file:// or no server) — sanity only.
- [ ] **Step 5: Deploy** — `git push origin HEAD:main`; `git -C <main worktree> merge --ff-only origin/main`; poll the live site/health and (optionally) connect a ws to confirm bots fill. Confirm `npm test` green.

---

## Self-review notes
- **Spec coverage:** ephemeral bot keys (Bot-1), helpers+ranked+headcount (Bot-2), ranked gate on all hooks + bots-earn-nothing (Bot-3), lifecycle/fill/fade/drop (Bot-4), AI+tick (Bot-5), integration+verify+deploy (Bot-6). Covered.
- **Type/scope consistency:** `humanCount/isRanked/botTarget/botWalkable/botBlastCells/botDangerSet/botThink` are module-scope and exported where tested; `makeBot/syncBots/botName` are module-scope using `botSeq` for ids (Bot-4 Step 4 scope note) so `newRound` can call them; `ws:{readyState:3}` stub keeps every `p.ws.send` guard safe. `settleDeath(room,victim,killer)` signature unchanged (now reads `room.players` via `isRanked`).
- **Known soft spots flagged:** the implementer must (a) confirm `resetPlayer` runs for bots via `addPlayer` so `p.ai` is set (Bot-5 Step 1), (b) verify `nextId` vs `botSeq` id scoping (Bot-4 Step 4), (c) locate each economy hook by content (not line) when adding the `isRanked`/`!bot` guards (Bot-3 Step 4), and (d) ensure the round-drop now keys off `humanCount`, not `players.size`.
```
