# Spectator Mode Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A "WATCH" button opens a read-only spectator view of a live arena; spectators get snapshots but aren't players (no cap/ranked/economy impact).

**Spec:** docs/superpowers/specs/2026-06-19-spectator-mode-design.md

---

## Task Spec-1: server-side spectators (TDD)

**Files:** `server.js`; Test: `test/spectator.test.js`.

Relevant existing code (find by content): `makeRoom(...)` (builds the room object with `players: new Map()`); `roomsByKey` (Map of `mode+":"+mapId` → array of rooms) and `roomFor` inside `startServer`; the WS message handler `if (m.t === "join") {...} else if (!player || !room) return; else if (...)`; the snapshot loop (`snapTimer`) that builds `str` and sends to `room.players`; `broadcast(room, obj)` (guards bots/closed); the `ws.on("close")` handler; the room-drop in close (`if (humanCount(room)===0){...dropRoom(room);}`).

- [ ] **Step 1: Failing integration test** — `test/spectator.test.js`:
```js
const test=require("node:test"); const assert=require("node:assert");
const os=require("os"),path=require("path"),fs=require("fs"); const WebSocket=require("ws");
process.env.KABOOM_DATA=path.join(os.tmpdir(),"kaboomies-spec-"+process.pid+".json");
const game=require("../server");
test.after(()=>{try{fs.unlinkSync(process.env.KABOOM_DATA);}catch(e){}});
const open=(port)=>new Promise(r=>{const ws=new WebSocket("ws://127.0.0.1:"+port);ws.on("open",()=>r(ws));});

test("spectate with no live room replies nospec", async () => {
  const server=game.startServer(0); await new Promise(r=>server.once("listening",r));
  const port=server.address().port;
  const ws=await open(port); let nospec=false;
  ws.on("message",raw=>{try{if(JSON.parse(raw).t==="nospec")nospec=true;}catch(e){}});
  ws.send(JSON.stringify({t:"spectate",map:"brawl",mode:"play"}));
  await new Promise(r=>setTimeout(r,400));
  ws.close(); await new Promise(r=>server.close(r));
  assert.ok(nospec,"expected nospec when no room exists");
});

test("a spectator watches a live room without being a player, and gets ended when it empties", async () => {
  const server=game.startServer(0); await new Promise(r=>server.once("listening",r));
  const port=server.address().port;
  const a=await open(port); // player creates a live room (bots fill it)
  a.send(JSON.stringify({t:"join",name:"P",base:"hero",skin:"#e8b07a",clothes:"#fff",map:"brawl",mode:"play"}));
  await new Promise(r=>setTimeout(r,600));
  const b=await open(port); let specInit=false,bSnaps=0,maxPlayers=0,ended=false;
  b.on("message",raw=>{try{const m=JSON.parse(raw);
    if(m.t==="init"&&m.spectator)specInit=true;
    if(m.t==="s"){bSnaps++;maxPlayers=Math.max(maxPlayers,m.players.length);}
    if(m.t==="ended")ended=true;}catch(e){}});
  b.send(JSON.stringify({t:"spectate",map:"brawl",mode:"play"}));
  await new Promise(r=>setTimeout(r,800));
  assert.ok(specInit,"spectator should get init with spectator:true");
  assert.ok(bSnaps>=1,"spectator should receive snapshots");
  const playersWhileWatching=maxPlayers;
  a.close(); // last human leaves -> room drops
  await new Promise(r=>setTimeout(r,500));
  b.close(); await new Promise(r=>server.close(r));
  assert.ok(ended,"spectator should be told the match ended when the room empties");
  assert.ok(playersWhileWatching>=1,"saw the live game's players");
});
```

- [ ] **Step 2:** `npm test` → spectator tests FAIL (no spectate handling).

- [ ] **Step 3: `room.spectators`** — in `makeRoom`, add `spectators: new Set(),` to the returned room object (next to `players: new Map()`).

- [ ] **Step 4: extend `broadcast` to include spectators** — change `broadcast`:
```js
function broadcast(room, obj) {
  const str = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(str);
  if (room.spectators) for (const ws of room.spectators) if (ws.readyState === 1) ws.send(str);
}
```

- [ ] **Step 5: handle `spectate`** — in the WS message handler, add a branch right after the `join` branch and BEFORE `else if (!player || !room) return;`:
```js
      } else if (m.t === "spectate") {
        if (player || spectating) return;            // already in something
        const mapId = MAPS[m.map] ? m.map : DEFAULT_MAP;
        const mode = (m.mode === "real") ? "real" : "play";
        const list = roomsByKey.get(mode + ":" + mapId) || [];
        const r = list.find(rm => humanCount(rm) >= 1);
        if (!r) { ws.send(JSON.stringify({ t: "nospec" })); return; }
        specRoom = r; spectating = true; r.spectators.add(ws);
        ws.send(JSON.stringify({ t: "init", spectator: true, map: r.mapId, mode: r.mode,
          COLS: r.cols, ROWS: r.rows, TILE, W: r.W, H: r.H, fuse: FUSE, grid: r.grid, seed: r.seed }));
```
  Declare the closure vars near `let player = null, room = null;`: add `let spectating = false, specRoom = null;`.

- [ ] **Step 6: send snapshots to spectators** — in the snapshot loop, after the players send loop, add:
```js
      for (const sws of room.spectators) { if (sws.readyState === 1) sws.send(str); else room.spectators.delete(sws); }
```
  (Right after `for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(str);`.)

- [ ] **Step 7: cleanup on close + on room drop**
  - In `ws.on("close")`, at the top, add: `if (spectating && specRoom) { specRoom.spectators.delete(ws); }`.
  - In the room-drop branch (`if (humanCount(room) === 0) {...}`), BEFORE `dropRoom(room)`, notify + clear spectators:
```js
        for (const sws of room.spectators) { try { if (sws.readyState === 1) sws.send(JSON.stringify({ t: "ended" })); } catch (e) {} }
        room.spectators.clear();
```

- [ ] **Step 8: route the round message through broadcast (if not already)** — confirm the round-restart uses `broadcast(room, { t:"round", ... })` (it does). No change needed beyond Step 4.

- [ ] **Step 9:** `npm test` → all pass (incl. spectator). `node --check server.js`.
- [ ] **Step 10: Commit** `git add server.js test/spectator.test.js && git commit -m "feat: server-side spectators (watch a live room, no player/economy impact)"`

---

## Task Spec-2: client spectator view

**Files:** `public/index.html`.

Relevant existing code: `renderArenas(maps)` (builds arena cards; card.onclick=joinMap); `async function joinMap(id)`; `connect()` and its `ws.onopen` (sends the join); the `ws.onmessage` `m.t==="init"` branch; `sendInput()`, `bomb()`, `detonate()`; `showScreen`; the touch/emote/ptt/mic elements; `#topbar`/HUD.

- [ ] **Step 1: `spectating` flag + spectate()** — add a module flag `let spectating=false;` and:
```js
async function spectate(id){ selMap=id; Store.set("bb_map",id); spectating=true; initAudio(); connect(); }
```

- [ ] **Step 2: WATCH button on cards** — in `renderArenas`, append a watch button to each card when `m.players > 0`, as a separate element so it doesn't trigger the card's join:
```js
    if(m.players>0){ const w=document.createElement("button"); w.className="watch-btn"; w.textContent="👁 WATCH";
      w.onclick=(ev)=>{ev.stopPropagation();spectate(m.id);}; card.appendChild(w); }
```
  Add CSS for `.watch-btn` (small, on-brand: e.g. `font-family:var(--display);font-size:8px;margin-top:10px;padding:6px 9px;border:3px solid var(--ink);background:#fff;box-shadow:3px 3px 0 var(--ink);cursor:pointer;`).

- [ ] **Step 3: send spectate on open** — in `connect()`'s `ws.onopen`, branch:
```js
  ws.onopen=()=>{settled=true;clearTimeout(fb);
    if(spectating){ ws.send(JSON.stringify({t:"spectate",map:selMap,mode:selMode})); return; }
    const name=($("nameInp").value||"Player").slice(0,14);
    ws.send(JSON.stringify({t:"join",name,base:playerSkin.base,skin:playerSkin.skin,clothes:playerSkin.clothes,map:selMap,mode:selMode,wallet:walletAddr,auth:pendingAuth}));};
```

- [ ] **Step 4: init handling for spectator** — in `m.t==="init"`, after applying COLS/ROWS/TILE/W/H/grid/seed/theme + `CV.width/CV.height/connected=true/showScreen("game")`, branch on `m.spectator`:
  - if spectator: add a body/screen class `spectating` (CSS hides `#touch`, `#emote-bar`, `#ptt-btn`, `#mic-btn`, `#bal-hud`, `#abil`), show a `#spectate-bar` banner "👁 SPECTATING" + a LEAVE button (calls `leaveSpectate()`); do NOT call `micState`/voice.
  - if not spectator: existing behavior.
  Implement via toggling a class on `#screen-game` (e.g. `$("screen-game").classList.toggle("spectating", !!m.spectator)`), and add the `#spectate-bar` element + CSS.

- [ ] **Step 5: suppress input** — at the top of `sendInput()`, `bomb()`, `detonate()`: `if(spectating)return;`.

- [ ] **Step 6: ended/nospec + leave** — in `ws.onmessage`:
```js
    if(m.t==="nospec"){ spectating=false; try{ws.close();}catch(e){} setStatus&&0; showScreen("lobby"); const n=$("mode-note"); if(n)n.textContent="No live game on this arena yet."; return; }
    if(m.t==="ended"){ leaveSpectate("Match ended — back to the lobby."); return; }
```
  Add `function leaveSpectate(note){ spectating=false; try{ws.close();}catch(e){} $("screen-game").classList.remove("spectating"); showScreen("lobby"); if(note){const n=$("mode-note");if(n)n.textContent=note;} }`. Wire the banner LEAVE button to `leaveSpectate()`.

- [ ] **Step 7: reset spectating on any exit** — ensure `joinMap` sets `spectating=false` at its start (so a normal join is never treated as spectating), and the lobby back button clears it.

- [ ] **Step 8: CSS** — add `#spectate-bar` (fixed top banner, on-brand) and `#screen-game.spectating #touch, ... { display:none !important }` rules for the hidden elements.

- [ ] **Step 9: Verify in preview** — open two contexts: hard to do two clients in one preview, so: start server, join a brawl as a player via one eval (`joinMap('brawl')`) — actually that occupies the page. Instead: verify the WATCH button appears on a populated arena card and clicking it enters a no-controls SPECTATING view that renders the game (use a second connection via the integration test for the data path; preview confirms the UI). Screenshot the spectator view (banner, no dpad). Confirm normal joinMap still works and isn't treated as spectating.

- [ ] **Step 10: Commit** `git add public/index.html && git commit -m "feat: spectator view — WATCH button, read-only game view, no controls"`

---

## Task Spec-3: verify + deploy
- [ ] `npm test` all green; `node --check server.js`.
- [ ] Preview: WATCH a live arena (the integration test proves the data path; preview confirms the UI/SPECTATING view + LEAVE).
- [ ] `git push origin HEAD:main`; ff-merge local main; live-confirm: connect a spectator ws to wss://kaboomies.fun after a player is in a room → receives spectator init + snapshots.

## Self-review notes
- Coverage: server spectators + spectate + nospec + ended + snapshot/round delivery + cleanup (Spec-1); client watch button + spectate flow + input suppression + ended/nospec/leave (Spec-2); verify+deploy (Spec-3).
- Consistency: `{t:"spectate",map,mode}` ↔ server handler; `{t:"init",spectator:true,...}` ↔ client init branch; `{t:"nospec"}`/`{t:"ended"}` ↔ client handlers; `broadcast` now includes `room.spectators` (used for round); snapshot loop sends to spectators.
- Soft spots: place the `spectate` branch BEFORE the `!player||!room` guard; declare `spectating`/`specRoom` closure vars; reset client `spectating` on every exit so a later real join isn't mis-flagged.
