# Character Unlocks + Arena Stakes + Lobby Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Hero-only default with stat-milestone character unlocks; a per-kill/death stake mechanic (±10/±100/±1000) replacing the death-drop economy; a bigger lobby with a premium High Roller card; and an FNF WARS teaser tab.

**Architecture:** A new pure `characters.js` (unlock logic) is unit-tested and consumed by `server.js` (profile + a `/characters` route + join enforcement). The death economy is replaced by `settleDeath` (direct transfer). The client (`public/index.html`) renders the locked/unlocked picker, the revamped lobby cards, and the FNF tab.

**Tech Stack:** Node `node --test`, `ws`, vanilla JS + Canvas. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-18-characters-and-arenas-design.md`

---

## Task A: `characters.js` pure unlock logic (TDD)

**Files:** Create `characters.js`; Test `test/characters.test.js`.

- [ ] **Step 1: Write failing tests** — `test/characters.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const c = require("../characters");

test("hero is always unlocked, even with empty stats", () => {
  assert.strictEqual(c.isUnlocked("hero", {}), true);
  assert.strictEqual(c.DEFAULT_BASE, "hero");
});
test("house unlocks at 3 games", () => {
  assert.strictEqual(c.isUnlocked("house", { games: 2 }), false);
  assert.strictEqual(c.isUnlocked("house", { games: 3 }), true);
});
test("wif unlocks at 100 kills", () => {
  assert.strictEqual(c.isUnlocked("wif", { kills: 99 }), false);
  assert.strictEqual(c.isUnlocked("wif", { kills: 100 }), true);
});
test("mitch uses level", () => {
  assert.strictEqual(c.isUnlocked("mitch", { level: 4 }), false);
  assert.strictEqual(c.isUnlocked("mitch", { level: 5 }), true);
});
test("bull needs 25 wins", () => {
  assert.strictEqual(c.isUnlocked("bull", { wins: 24 }), false);
  assert.strictEqual(c.isUnlocked("bull", { wins: 25 }), true);
});
test("unknown base is never unlocked", () => {
  assert.strictEqual(c.isUnlocked("nope", { kills: 9999, games: 9999 }), false);
  assert.strictEqual(c.isUnlocked(undefined, { kills: 9999 }), false);
});
test("unlockState returns 8 entries, hero first + unlocked, with progress", () => {
  const st = c.unlockState({ games: 3, kills: 100, wins: 0, crates: 0, pickups: 0, level: 1 });
  assert.strictEqual(st.length, 8);
  assert.strictEqual(st[0].base, "hero");
  assert.strictEqual(st[0].unlocked, true);
  const house = st.find(x => x.base === "house");
  assert.strictEqual(house.unlocked, true);
  assert.strictEqual(house.prog, 3);
  const wif = st.find(x => x.base === "wif");
  assert.strictEqual(wif.unlocked, true);
  const bull = st.find(x => x.base === "bull");
  assert.strictEqual(bull.unlocked, false);
  assert.strictEqual(bull.target, 25);
});
```

- [ ] **Step 2: Run `npm test`** → new file FAILS ("Cannot find module '../characters'").

- [ ] **Step 3: Implement `characters.js`:**

```js
/* Pure character-unlock logic. Hero is always unlocked; the other characters
   unlock from persistent stats (verified wallets only). No IO. XP-only economy. */

const DEFAULT_BASE = "hero";

// stat is a key of the stats object, or "level"; target is the threshold (>=).
const CHARACTER_REQS = [
  { base: "house",  name: "Chillhouse",     label: "Play 3 games",     stat: "games",  target: 3   },
  { base: "popcat", name: "Popcat",         label: "Break 100 crates", stat: "crates", target: 100 },
  { base: "sahur",  name: "Tung Sahur",     label: "Win 5 rounds",     stat: "wins",   target: 5   },
  { base: "alon",   name: "ALON",           label: "Play 25 games",    stat: "games",  target: 25  },
  { base: "mitch",  name: "MITCH",          label: "Reach Level 5",    stat: "level",  target: 5   },
  { base: "wif",    name: "WIF",            label: "Get 100 kills",    stat: "kills",  target: 100 },
  { base: "bull",   name: "The Black Bull", label: "Win 25 rounds",    stat: "wins",   target: 25  },
].map(Object.freeze);
Object.freeze(CHARACTER_REQS);

function statValue(s, key) { return (s && typeof s[key] === "number") ? s[key] : 0; }

function isUnlocked(base, s) {
  if (base === DEFAULT_BASE) return true;
  const req = CHARACTER_REQS.find(r => r.base === base);
  if (!req) return false;
  return statValue(s, req.stat) >= req.target;
}

// s = {games,kills,wins,crates,pickups,level}; returns 8 entries (hero first).
function unlockState(s) {
  const hero = { base: "hero", name: "Hero", label: "Starter", stat: null, target: 0, prog: 0, unlocked: true };
  const rest = CHARACTER_REQS.map(r => {
    const prog = statValue(s, r.stat);
    return { base: r.base, name: r.name, label: r.label, stat: r.stat, target: r.target, prog, unlocked: prog >= r.target };
  });
  return [hero, ...rest];
}

module.exports = { DEFAULT_BASE, CHARACTER_REQS, isUnlocked, unlockState, statValue };
```

- [ ] **Step 4: Run `npm test`** → all pass.
- [ ] **Step 5: Commit** `git add characters.js test/characters.test.js && git commit -m "feat: characters.js pure unlock logic"`

---

## Task B: server.js — characters in /profile, GET /characters, join enforcement (TDD)

**Files:** Modify `server.js`; Test: extend `test/profile.test.js`.

- [ ] **Step 1: Add failing tests** (append to `test/profile.test.js`):

```js
test("buildProfile includes 8-character unlock state", () => {
  const p = game.buildProfile("walletChars", "Cee");
  assert.strictEqual(p.characters.length, 8);
  assert.strictEqual(p.characters[0].base, "hero");
  assert.strictEqual(p.characters[0].unlocked, true);
});

test("GET /characters returns the requirement defs (no auth)", async () => {
  const server = game.startServer(0);
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/characters", method: "GET" },
      (res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b) })); });
    req.on("error", reject); req.end();
  });
  try {
    assert.strictEqual(body.status, 200);
    assert.strictEqual(body.json.default, "hero");
    assert.ok(Array.isArray(body.json.reqs) && body.json.reqs.length === 7);
    assert.ok(body.json.reqs.every(r => r.base && r.label && typeof r.target === "number"));
  } finally { await new Promise(r => server.close(r)); }
});
```

- [ ] **Step 2: Run `npm test`** → the two new tests FAIL.

- [ ] **Step 3: Require characters** — after `const quests = require("./quests");` add:
```js
const characters = require("./characters");
```

- [ ] **Step 4: Add `characters` to `buildProfile`** — in the returned object (after `quests:`), add:
```js
    characters: characters.unlockState({ games: s.games, kills: s.kills, wins, crates: s.crates, pickups: s.pickups, level: prog.level }),
```

- [ ] **Step 5: Add the `GET /characters` route** — in the http handler, near the `/scores` route, add:
```js
    if (url === "/characters") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ default: characters.DEFAULT_BASE, reqs: characters.CHARACTER_REQS }));
    }
```

- [ ] **Step 6: Join enforcement** — in the join handler, after `const key = ...;` and before building `player`, compute the allowed base and use it:
```js
        const ustats = verified ? { ...store.getStats(key), level: store.levelFromXp(store.getXp(key)) } : {};
        const allowedBase = characters.isUnlocked(m.base, ustats) ? m.base : characters.DEFAULT_BASE;
```
Then in the `player = { ... base: m.base || "house", ... }` object, change `base:` to:
```js
          base: allowedBase, skin: m.skin || "#e8b07a", clothes: m.clothes || "#7d8aa0",
```

- [ ] **Step 7: Export `characters`** — add `characters` to `module.exports` (next to `store, auth, quests`-style exports). Find the exports object and add it.

- [ ] **Step 8: Run `npm test`** → all pass. Run `node --check server.js`.
- [ ] **Step 9: Commit** `git add server.js test/profile.test.js && git commit -m "feat: character unlock state in /profile, GET /characters, join enforcement"`

---

## Task C: server.js — arena stakes mechanic (settleDeath) + pickups repurpose (TDD)

**Files:** Modify `server.js`; Test: extend `test/profile.test.js` (or a new `test/economy.test.js`).

> This replaces the death-drop/pot economy with a direct transfer. Read the current `killDrop` (around line 510), the blast-death path (the `tick` damage loop, around line 558-574), the crush-death path (in `closeRing`, search `crush`), and the power-up pickup site (where `room.ups` is consumed — search for where a player gains `kick`/`range`/`pierce`/`shield`/`maxBombs` from a tile).

- [ ] **Step 1: Write failing test** — create `test/economy.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const os = require("os"); const path = require("path"); const fs = require("fs");
const TMP = path.join(os.tmpdir(), "kaboomies-econ-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const game = require("../server");
const store = game.store;
test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

function room(stake) { return { deathDrop: stake, cur: "play" }; }

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
```

- [ ] **Step 2: Run `npm test`** → these FAIL ("game.settleDeath is not a function").

- [ ] **Step 3: Add `settleDeath` and remove `killDrop`** — replace the `killDrop` function with:
```js
// arena stakes: a death transfers exactly `stake` (capped at the victim's balance)
// from victim to killer; self/environment deaths burn it. Replaces the old
// drop-to-pot/floor economy in training.
function settleDeath(room, victim, killer) {
  const stake = room.deathDrop != null ? room.deathDrop : DEATH_DROP;
  const lost = Math.min(stake, bal(victim.key, room.cur));
  victim.streak = 0;
  if (lost <= 0) return;
  setBal(victim.key, bal(victim.key, room.cur) - lost, victim.name, room.cur);
  if (killer && killer.id !== victim.id && killer.alive)
    setBal(killer.key, bal(killer.key, room.cur) + lost, killer.name, room.cur);
}
```

- [ ] **Step 4: Repoint the death paths**
  - In the blast-death path, replace `killDrop(room, pl);` with `settleDeath(room, pl, killer);`.
  - In the crush-death path (`closeRing`), replace `killDrop(room, pl);` with `settleDeath(room, pl, null);`.

- [ ] **Step 5: Repurpose pickups → power-ups**
  - Find the coin-drop pickup site (in `movePlayer`, where `room.drops` are collected and balance increased) and REMOVE the two lines `store.bumpStat(pl.key, "pickups");` and `bumpQuest(room, pl, "pickups");` from there (leave the rest; with no drops it's inert but harmless).
  - Find the power-up pickup site (where `room.ups` is consumed and the player gains an ability). Add right after the ability is granted:
```js
        store.bumpStat(pl.key, "pickups");
        bumpQuest(room, pl, "pickups");
```
  (Use the correct player variable in that scope.)

- [ ] **Step 6: Update exports** — in `module.exports`, replace `killDrop` with `settleDeath` (and confirm nothing else references `killDrop`; remove the `BOUNTY_STEP`/`BOUNTY_MAX` chip usage that lived only in the old `killDrop`).

- [ ] **Step 7: Run `npm test`** (all pass incl. economy) and `node --check server.js`.
- [ ] **Step 8: Commit** `git add server.js test/economy.test.js && git commit -m "feat: per-kill/death stake transfer (settleDeath) + pickups count power-ups"`

---

## Task D: client — default Hero + locked/unlocked character picker

**Files:** Modify `public/index.html`.

- [ ] **Step 1: Default to hero**
  - Change the `playerSkin` default `base:"house"` → `base:"hero"`.
  - The load guard `if(!playerSkin.base||!BASES.some(...))playerSkin.base="house"` → `"hero"`.

- [ ] **Step 2: Add unlock loading** — add near the other lobby/customizer JS:
```js
let charReqs=null;        // [{base,label,target,stat}] from GET /characters
let charUnlock=null;      // Set of unlocked base ids for the current player (null = guest/unknown)
let charProg={};          // base -> {prog,target,label}
async function loadCharacters(){
  if(!charReqs){ try{ const r=await fetch("/characters"); const j=await r.json(); charReqs=j.reqs; }catch(e){ charReqs=[]; } }
  charUnlock=new Set(["hero"]); charProg={};
  const auth = walletAddr ? await signLogin() : null;
  if(auth&&walletAddr){
    try{ const r=await fetch("/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({wallet:walletAddr,auth})});
      if(r.ok){ const p=await r.json(); for(const ch of p.characters){ if(ch.unlocked)charUnlock.add(ch.base); charProg[ch.base]={prog:ch.prog,target:ch.target,label:ch.label}; } } }catch(e){}
  } else {
    for(const rq of charReqs) charProg[rq.base]={prog:0,target:rq.target,label:rq.label};
  }
}
```

- [ ] **Step 3: Gate the picker** — in `buildCustomizer`, where `BASES.forEach` builds the character buttons, render lock state:
  - unlocked (`charUnlock.has(bs.id)`): normal button (selectable, sets `playerSkin.base`).
  - locked: add class `locked`, prefix `🔒`, disable selection, and append a small requirement line using `charProg[bs.id]` (e.g. `WIF · 100 kills (62/100)` — use `charProg[bs.id].label` + `(prog/target)`).
  Example button build:
```js
  BASES.forEach(bs=>{const unlocked=!charUnlock||charUnlock.has(bs.id);
    const b=document.createElement("button");
    b.className="hatbtn"+(playerSkin.base===bs.id?" sel":"")+(unlocked?"":" locked");
    const pr=charProg[bs.id];
    b.innerHTML=(unlocked?"":"🔒 ")+esc(bs.name)+(unlocked||!pr?"":'<span class="lockreq">'+esc(pr.label)+" ("+Math.min(pr.prog,pr.target)+"/"+pr.target+")</span>");
    if(unlocked) b.onclick=()=>{playerSkin.base=bs.id;Store.set("bb_skin",playerSkin);buildCustomizer();};
    else b.onclick=()=>{b.classList.add("nudge");setTimeout(()=>b.classList.remove("nudge"),400);};
    host.appendChild(b);});
```
  (Match the existing host/append pattern; `esc` already exists from the profile feature.)

- [ ] **Step 4: Reset a locked stored base** — after `loadCharacters()` resolves (e.g. when showing the create screen), if `playerSkin.base` is not in `charUnlock`, set it to `"hero"`, persist, and rebuild the customizer/preview.

- [ ] **Step 5: Call `loadCharacters()` when the create screen is shown** — in `showScreen`, when switching to "create", `await loadCharacters()` then `buildCustomizer()`. (If `showScreen` isn't async, call `loadCharacters().then(()=>buildCustomizer())`.)

- [ ] **Step 6: CSS for locked buttons** — add:
```css
  .hatbtn.locked{opacity:.5;cursor:not-allowed;}
  .hatbtn .lockreq{display:block;font-family:var(--body);font-size:11px;color:var(--grey);text-transform:none;margin-top:3px;}
  .hatbtn.nudge{animation:nudge .4s;}
  @keyframes nudge{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
```

- [ ] **Step 7: Verify in preview** (guest: only Hero selectable, others 🔒 with "(0/N)"; no console errors). Commit `git commit -am "feat: hero default + locked/unlocked character picker with milestones"`.

---

## Task E: client — lobby revamp (bigger cards, stake labels, order, FNF tab)

**Files:** Modify `public/index.html`.

- [ ] **Step 1: FNF tab** — in `#mode-bar`, after `#mode-real`, add:
```html
          <button class="mode-btn soon" id="mode-fnf">🔥 FNF Wars · soon</button>
```
  Wire its click to show a note (`#mode-note`) "Friday Night Fights — coming soon." and NOT change mode (mirror how the soon/real handling works; do not set `selMode`).

- [ ] **Step 2: Bigger cards + order** — change `.arena-list` grid to larger cards:
```css
  .arena-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px;max-width:1100px;}
  .arena-card{padding:22px 22px 20px;}
  .arena-card .an{font-size:15px;}
  .arena-card .stake{font-family:var(--display);font-size:12px;color:#b9821a;margin:10px 0 4px;}
  .arena-card .stake b{color:var(--ink);}
```
  Ensure the lobby renders arenas in stake order **Rookie Ring (10) → Brawl Arena (100) → High Roller (1000)**. In `renderArenas`, sort by `m.drop` ascending (the `/lobby` map objects already include `drop`).

- [ ] **Step 3: Stake label per card** — in `renderArenas`, add a stake line to each card showing the per-kill/death value using `m.drop`:
```js
    '<div class="stake">🪙 <b>±'+m.drop+'</b> $KABOOM · per kill/death</div>'
```
  Insert it into the card's innerHTML (after the name/size, before the players line). Keep the existing players/live line.

- [ ] **Step 4: Verify in preview** (three big cards, low→high, stake labels correct, FNF tab present and inert). Commit `git commit -am "feat: bigger lobby arena cards + stake labels + FNF Wars teaser tab"`.

---

## Task F: client — premium High Roller card (frontend-design skill)

**Files:** Modify `public/index.html`.

- [ ] **Step 1: Use the frontend-design skill** to craft a premium treatment for the High Roller (1000-stake) card that stays on-brand with the brutalist/pixel style but reads as premium: gold/amber border + shadow, a coin/`$` motif (reuse the 🪙 glyph or a small inline pixel-coin SVG), and a subtle shimmer/sheen. It must not regress the other two cards.
  - Add a `.premium` class applied to the High Roller card in `renderArenas` (detect by `m.drop===1000` or `m.id==="highroller"`).
  - Add the premium CSS (gold `--gold:#f5a623;` accents, `box-shadow` in gold, a `PREMIUM`/`👑` badge, optional `@keyframes shimmer`). Respect `prefers-reduced-motion`.

- [ ] **Step 2: Verify in preview** (High Roller clearly premium; others unchanged; mobile still scrolls/wraps). Commit `git commit -am "feat: premium High Roller arena card (gold/coin styling)"`.

---

## Task G: Verify in preview + deploy

- [ ] **Step 1:** `npm test` → all green; `node --check server.js characters.js`.
- [ ] **Step 2: Preview** — start server, screenshot: create screen (guest = Hero only, others locked w/ progress), lobby (3 big cards low→high, stake labels, premium High Roller, FNF tab). Use `preview_eval` with a mock `/profile` to confirm unlocked rendering of the picker too.
- [ ] **Step 3: Deploy** — `git push origin HEAD:main` then `git -C <main worktree> merge --ff-only origin/main`; poll the live site for the new markup (e.g. `mode-fnf` / `±` stake label) to confirm Railway redeployed.

---

## Self-review notes
- **Spec coverage:** unlock logic (A), profile/route/enforcement (B), stake mechanic + pickups repurpose (C), default+picker UI (D), lobby cards+order+FNF (E), premium card (F), verify+deploy (G). All covered.
- **Type consistency:** `unlockState` entry shape `{base,name,label,stat,target,prog,unlocked}` is produced in characters.js (A), surfaced in `/profile` (B), and read by the client (`ch.unlocked`, `ch.prog`, `ch.target`, `ch.label`) (D). `CHARACTER_REQS` `{base,name,label,stat,target}` returned by `/characters` (B) and read as `charReqs` (D). `settleDeath(room,victim,killer)` signature consistent between C's definition, tests, and the death-path calls.
- **Known soft spots flagged:** the implementer must locate (not by line number) the crush-death path in `closeRing`, the power-up pickup site, and the old coin-drop pickup site (Task C). The client `showScreen('create')` hook for `loadCharacters` (Task D Step 5) must match the actual `showScreen` implementation.
