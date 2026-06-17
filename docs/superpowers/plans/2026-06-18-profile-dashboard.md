# Profile Dashboard + Daily Quests + Login Streak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a profile dashboard (lifetime stats + daily quests + login streak) for verified wallets, rewarding XP only.

**Architecture:** A new pure `quests.js` module (quest pool, deterministic daily selection, streak math) is unit-tested. `store.js` gains per-wallet stat/streak/quest persistence. `server.js` bumps these in the existing event hooks, grants the login streak on join, exposes a verified `POST /profile` endpoint, and pushes completion toasts. `public/index.html` adds a `screen-profile` plus in-game toast handling.

**Tech Stack:** Node.js (built-in `node:test`/`node:assert`, no new deps), `ws`, `tweetnacl`+`bs58` (already present, used in tests to forge a valid signature), vanilla JS + Canvas client.

**Spec:** `docs/superpowers/specs/2026-06-18-profile-dashboard-design.md`

---

## File structure

- **Create `quests.js`** — pure logic: `QUEST_POOL`, `dayIndex(now)`, `todaysQuests(dayIdx)`, `nextStreak(prev, today)`. No IO. Fully unit-tested.
- **Modify `store.js`** — add `mem.stats/streak/quests`, getters/bumpers, `getWins`, `getName`. Backward compatible (missing → 0/empty).
- **Modify `server.js`** — require `quests`, add `bumpQuest`/`buildProfile`/`buildQuests` helpers, stat+quest bumps in hooks, streak grant on join, `init` additions, `POST /profile`, toast sends.
- **Modify `public/index.html`** — `screen-profile` markup + CSS, lobby `PROFIL` button, `openProfile()` fetch+render, back nav, guest teaser, in-game `{t:"toast"}` handling.
- **Create `test/quests.test.js`, `test/store.test.js`, `test/profile.test.js`** — `node --test`.
- **Modify `package.json`** — add `"test": "node --test"`.

---

## Task 1: Test runner + `quests.js` pure logic (TDD)

**Files:**
- Modify: `package.json` (scripts)
- Create: `quests.js`
- Test: `test/quests.test.js`

- [ ] **Step 1: Add the test script**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing tests**

Create `test/quests.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const q = require("../quests");

test("dayIndex is a contiguous UTC day number", () => {
  assert.strictEqual(q.dayIndex(0), 0);
  assert.strictEqual(q.dayIndex(86400000), 1);
  assert.strictEqual(q.dayIndex(86400000 * 100 + 123), 100);
});

test("todaysQuests returns exactly 3 distinct quests from the pool", () => {
  const day = 20100;
  const picks = q.todaysQuests(day);
  assert.strictEqual(picks.length, 3);
  const ids = picks.map(p => p.id);
  assert.strictEqual(new Set(ids).size, 3);
  for (const p of picks) assert.ok(q.QUEST_POOL.find(d => d.id === p.id));
});

test("todaysQuests is deterministic for a given day and varies by day", () => {
  assert.deepStrictEqual(q.todaysQuests(20100), q.todaysQuests(20100));
  const a = q.todaysQuests(20100).map(p => p.id).join(",");
  const b = q.todaysQuests(20101).map(p => p.id).join(",");
  // not guaranteed different every adjacent pair, but over a span they must vary
  let varies = false;
  for (let d = 20100; d < 20140; d++) {
    if (q.todaysQuests(d).map(p => p.id).join(",") !== a) { varies = true; break; }
  }
  assert.ok(varies, "quest set should change across days");
});

test("nextStreak: first ever grants day 1 = 50 XP", () => {
  const r = q.nextStreak(null, 100);
  assert.deepStrictEqual(r, { count: 1, best: 1, day: 100, xpAwarded: 50 });
});

test("nextStreak: consecutive day increments and scales XP", () => {
  const r = q.nextStreak({ count: 1, best: 1, day: 100 }, 101);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.xpAwarded, 75);
  assert.strictEqual(r.best, 2);
});

test("nextStreak: same day grants nothing", () => {
  const r = q.nextStreak({ count: 3, best: 5, day: 100 }, 100);
  assert.deepStrictEqual(r, { count: 3, best: 5, day: 100, xpAwarded: 0 });
});

test("nextStreak: gap resets to 1 but keeps best", () => {
  const r = q.nextStreak({ count: 6, best: 6, day: 100 }, 103);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.best, 6);
  assert.strictEqual(r.xpAwarded, 50);
});

test("nextStreak: XP caps at 200", () => {
  const r = q.nextStreak({ count: 20, best: 20, day: 100 }, 101);
  assert.strictEqual(r.xpAwarded, 200);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../quests'`.

- [ ] **Step 4: Implement `quests.js`**

Create `quests.js`:

```js
/* Pure daily-quest + login-streak logic (no IO, unit-tested).
   Rewards are XP only; account level is prestige (no combat power). */

const QUEST_POOL = [
  { id: "win",     label: "Win a round",      target: 1,  xp: 150 },
  { id: "kills",   label: "Get 5 kills",      target: 5,  xp: 100 },
  { id: "crates",  label: "Break 25 crates",  target: 25, xp: 75  },
  { id: "pickups", label: "Grab 6 power-ups", target: 6,  xp: 75  },
  { id: "games",   label: "Play 4 rounds",    target: 4,  xp: 75  },
];

// contiguous UTC day number (unlike YYYYMMDD dailySeed) -> clean streak math
function dayIndex(now) { return Math.floor(now / 86400000); }

// deterministic PRNG so all players get the same 3 quests on a given day
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function todaysQuests(dayIdx) {
  const pool = QUEST_POOL.slice();
  const rand = lcg((dayIdx >>> 0) + 1);
  for (let i = pool.length - 1; i > 0; i--) {            // seeded Fisher–Yates
    const j = Math.floor(rand() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, 3);
}

// prev: {count,best,day} | null ; today: dayIndex. Returns next state + xpAwarded.
function nextStreak(prev, today) {
  const p = (prev && typeof prev.day === "number") ? prev : { count: 0, best: 0, day: -1 };
  if (p.day === today) return { count: p.count, best: p.best || 0, day: p.day, xpAwarded: 0 };
  const count = (p.day === today - 1) ? p.count + 1 : 1;
  const best = Math.max(p.best || 0, count);
  const xpAwarded = Math.min(50 + (count - 1) * 25, 200);
  return { count, best, day: today, xpAwarded };
}

module.exports = { QUEST_POOL, dayIndex, todaysQuests, nextStreak };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `quests.test.js` tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json quests.js test/quests.test.js
git commit -m "feat: quests.js pure logic (daily quest pick + streak math) + test runner"
```

---

## Task 2: `store.js` stat/streak/quest persistence (TDD)

**Files:**
- Modify: `store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/store.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// isolate persistence to a temp file BEFORE requiring the module
const TMP = path.join(os.tmpdir(), "kaboomies-store-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const store = require("../store");

test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

test("getStats defaults all counters to 0 for unknown keys", () => {
  assert.deepStrictEqual(store.getStats("walletA"),
    { games: 0, kills: 0, deaths: 0, crates: 0, pickups: 0 });
});

test("bumpStat increments a counter for a wallet key", () => {
  store.bumpStat("walletA", "kills");
  store.bumpStat("walletA", "kills", 4);
  store.bumpStat("walletA", "crates", 10);
  const s = store.getStats("walletA");
  assert.strictEqual(s.kills, 5);
  assert.strictEqual(s.crates, 10);
});

test("bumpStat ignores guest keys", () => {
  store.bumpStat("guest:7", "kills", 3);
  assert.strictEqual(store.getStats("guest:7").kills, 0);
});

test("streak getter/setter round-trips and defaults", () => {
  assert.deepStrictEqual(store.getStreak("walletB"), { count: 0, best: 0, day: -1 });
  store.setStreak("walletB", { count: 3, best: 5, day: 42 });
  assert.deepStrictEqual(store.getStreak("walletB"), { count: 3, best: 5, day: 42 });
});

test("getQuestState fresh-resets when the day changes (wallet keys)", () => {
  const q1 = store.getQuestState("walletC", 100);
  q1.prog.kills = 2; q1.done.kills = false;
  store.setQuestState("walletC", q1);
  assert.strictEqual(store.getQuestState("walletC", 100).prog.kills, 2);
  const q2 = store.getQuestState("walletC", 101);   // new day -> reset
  assert.deepStrictEqual(q2.prog, {});
  assert.deepStrictEqual(q2.done, {});
});

test("getQuestState never persists for guest keys", () => {
  const g = store.getQuestState("guest:9", 100);
  g.prog.kills = 5;
  store.setQuestState("guest:9", g);
  assert.deepStrictEqual(store.getQuestState("guest:9", 100).prog, {});
});

test("getWins / getName getters", () => {
  store.bumpWin("walletD", "Dee");
  assert.strictEqual(store.getWins("walletD"), 1);
  assert.strictEqual(store.getName("walletD"), "Dee");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `store.getStats is not a function` (and siblings).

- [ ] **Step 3: Extend the in-memory model**

In `store.js`, update the `mem` initializer and `loadFile` to include the new maps.

Change:
```js
let mem = { balances: {}, wins: {}, names: {}, xp: {}, real: {} };
```
to:
```js
let mem = { balances: {}, wins: {}, names: {}, xp: {}, real: {}, stats: {}, streak: {}, quests: {} };
```

In `loadFile`, after `mem.real = j.real || {};` add:
```js
    mem.stats = j.stats || {};
    mem.streak = j.streak || {};
    mem.quests = j.quests || {};
```

- [ ] **Step 4: Add getters/bumpers + wallet guard**

In `store.js`, just before the `module.exports` line, add:

```js
// ---- per-account stats / streak / quests (verified wallets only; XP-only economy) ----
function isWalletKey(key) { return !!key && !key.startsWith("guest:"); }

function getStats(key) {
  const s = mem.stats[key] || {};
  return { games: s.games || 0, kills: s.kills || 0, deaths: s.deaths || 0,
           crates: s.crates || 0, pickups: s.pickups || 0 };
}
function bumpStat(key, field, n = 1) {
  if (!isWalletKey(key)) return;
  const s = mem.stats[key] || (mem.stats[key] = {});
  s[field] = (s[field] || 0) + n;
  saveSoon();
}

function getStreak(key) {
  const s = mem.streak[key];
  return s ? { count: s.count || 0, best: s.best || 0, day: typeof s.day === "number" ? s.day : -1 }
           : { count: 0, best: 0, day: -1 };
}
function setStreak(key, st) {
  if (!isWalletKey(key)) return;
  mem.streak[key] = { count: st.count, best: st.best, day: st.day };
  saveSoon();
}

// returns {day,prog,done}; resets (and persists) when the stored day != today.
function getQuestState(key, today) {
  if (!isWalletKey(key)) return { day: today, prog: {}, done: {} };
  let q = mem.quests[key];
  if (!q || q.day !== today) { q = { day: today, prog: {}, done: {} }; mem.quests[key] = q; saveSoon(); }
  return q;
}
function setQuestState(key, q) {
  if (!isWalletKey(key)) return;
  mem.quests[key] = { day: q.day, prog: q.prog || {}, done: q.done || {} };
  saveSoon();
}

function getWins(key) { return mem.wins[key] || 0; }
function getName(key) { return mem.names[key] || null; }
```

- [ ] **Step 5: Export the new functions**

In `store.js`, change the export line from:
```js
module.exports = { init, getBalance, setBalance, bumpWin, topScores, getXp, addXp, levelFromXp, levelProgress, useSupa };
```
to:
```js
module.exports = { init, getBalance, setBalance, bumpWin, topScores, getXp, addXp, levelFromXp, levelProgress, useSupa,
  getStats, bumpStat, getStreak, setStreak, getQuestState, setQuestState, getWins, getName };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — `quests.test.js` and `store.test.js` all green.

- [ ] **Step 7: Commit**

```bash
git add store.js test/store.test.js
git commit -m "feat: persist per-wallet stats, streak and quest progress"
```

---

## Task 3: `server.js` — profile builder + quest/streak helpers (TDD)

**Files:**
- Modify: `server.js` (require + helpers + exports)
- Test: `test/profile.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/profile.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "kaboomies-profile-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const game = require("../server");
const store = game.store;

test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

test("buildProfile returns level, stats, streak and 3 quests", () => {
  store.bumpStat("walletP", "kills", 7);
  store.bumpStat("walletP", "deaths", 2);
  store.bumpStat("walletP", "games", 4);
  store.bumpWin("walletP", "Pat");
  const p = game.buildProfile("walletP", "Pat");
  assert.strictEqual(p.stats.kills, 7);
  assert.strictEqual(p.stats.deaths, 2);
  assert.strictEqual(p.stats.games, 4);
  assert.strictEqual(p.stats.wins, 1);
  assert.strictEqual(p.stats.winRate, 25);          // 1/4
  assert.strictEqual(p.stats.kd, 3.5);              // 7/2
  assert.ok(p.level >= 1);
  assert.strictEqual(p.quests.length, 3);
  assert.ok("count" in p.streak && "best" in p.streak);
});

test("buildProfile K/D with zero deaths equals kills", () => {
  store.bumpStat("walletQ", "kills", 5);
  const p = game.buildProfile("walletQ", null);
  assert.strictEqual(p.stats.kd, 5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `game.buildProfile is not a function`.

- [ ] **Step 3: Require `quests` in `server.js`**

In `server.js`, just after `const auth = require("./auth");` add:
```js
const quests = require("./quests");
```

- [ ] **Step 4: Add `buildProfile`, `buildQuests`, `bumpQuest` helpers**

In `server.js`, immediately after the `gainXp` function (ends ~line 456), add:

```js
// ---- profile / daily quests / login streak (verified wallets only; XP-only) ----
function buildQuests(key, today) {
  const q = store.getQuestState(key, today);
  return quests.todaysQuests(today).map(d => ({
    id: d.id, label: d.label, target: d.target, xp: d.xp,
    prog: q.prog[d.id] || 0, done: !!q.done[d.id],
  }));
}

function buildProfile(key, name) {
  const today = quests.dayIndex(Date.now());
  const prog = store.levelProgress(store.getXp(key));
  const s = store.getStats(key);
  const wins = store.getWins(key);
  const st = store.getStreak(key);
  return {
    name: name || null,
    level: prog.level, xp: { into: prog.into, need: prog.need },
    stats: {
      games: s.games, wins, winRate: s.games ? Math.round((wins / s.games) * 100) : 0,
      kills: s.kills, deaths: s.deaths, kd: s.deaths ? +(s.kills / s.deaths).toFixed(2) : s.kills,
      crates: s.crates, pickups: s.pickups,
    },
    streak: { count: st.count, best: st.best },
    quests: buildQuests(key, today),
  };
}

// advance one quest's progress; auto-grant XP + toast on completion. player may be undefined.
function bumpQuest(room, player, id, n = 1) {
  if (!player || !player.verified) return;
  const key = player.key, today = quests.dayIndex(Date.now());
  const def = quests.todaysQuests(today).find(d => d.id === id);
  if (!def) return;                                   // quest not active today
  const q = store.getQuestState(key, today);
  if (q.done[id]) return;
  q.prog[id] = (q.prog[id] || 0) + n;
  if (q.prog[id] >= def.target) {
    q.done[id] = true;
    gainXp(room, key, def.xp);
    if (player.ws && player.ws.readyState === 1)
      player.ws.send(JSON.stringify({ t: "toast", kind: "quest", label: def.label, xp: def.xp }));
  }
  store.setQuestState(key, q);
}
```

- [ ] **Step 5: Export the helpers**

In `server.js`, in the `module.exports` object add `buildProfile, buildQuests, bumpQuest` to the list (the line beginning `placeBomb, detonate, ...`):

```js
  placeBomb, detonate, explode, killDrop, tick, snapshot, store, auth,
  buildProfile, buildQuests, bumpQuest,
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — `profile.test.js` green (plus prior suites).

- [ ] **Step 7: Commit**

```bash
git add server.js test/profile.test.js
git commit -m "feat: buildProfile + bumpQuest helpers for the profile dashboard"
```

---

## Task 4: Wire stat/quest bumps into the game hooks + login streak + init

**Files:**
- Modify: `server.js` (pickup ~386, crate ~425, kill/death ~514-519, win ~559, round resolution, join handler ~676-689)

> No new unit test — these are inside the live game/WS loop. Verified by an
> integration check in Task 6 (forged signature) and the preview in Task 8.

- [ ] **Step 1: Pickup hook**

In `server.js` find (pickup, ~line 386):
```js
      setBal(pl.key, bal(pl.key, room.cur) + room.drops[i].a, null, room.cur);
      gainXp(room, pl.key, XP_PICKUP);
```
Add immediately after the `gainXp` line:
```js
      store.bumpStat(pl.key, "pickups");
      bumpQuest(room, pl, "pickups");
```

- [ ] **Step 2: Crate hook**

In `server.js` find (crate destroyed, ~line 425):
```js
        gainXp(room, ownerKey, XP_CRATE);
```
Add immediately after:
```js
        store.bumpStat(ownerKey, "crates");
        bumpQuest(room, [...room.players.values()].find(p => p.key === ownerKey), "crates");
```

- [ ] **Step 2b: Run tests (regression)**

Run: `npm test`
Expected: PASS (no behavior tested here yet, but ensures no syntax error).

- [ ] **Step 3: Kill + death hooks**

In `server.js` find (kill resolution, ~line 516-519):
```js
      pl.hp = 0; pl.alive = false;
      const by = !killer ? "a bomb" : (killer.id === pl.id ? null : killer.name);
      if (killer && killer.id !== pl.id && killer.alive) { killer.streak = (killer.streak || 0) + 1; gainXp(room, killer.key, XP_KILL); }
```
Replace that third line with the same line followed by the stat/quest bumps, and add a death bump:
```js
      pl.hp = 0; pl.alive = false;
      store.bumpStat(pl.key, "deaths");
      const by = !killer ? "a bomb" : (killer.id === pl.id ? null : killer.name);
      if (killer && killer.id !== pl.id && killer.alive) { killer.streak = (killer.streak || 0) + 1; gainXp(room, killer.key, XP_KILL); store.bumpStat(killer.key, "kills"); bumpQuest(room, killer, "kills"); }
```

- [ ] **Step 4: Crush death hook**

In `server.js` locate the crush handling that sets a player `alive = false` when caught by a closing wall (search for `crush`). Add a death bump where `alive` is set false for a crush, e.g. after the line that sets `pl.alive = false` in that branch:
```js
        store.bumpStat(pl.key, "deaths");
```
(If the crush branch reuses the same death path as Step 3, do not double-count — only add where a distinct `alive = false` assignment exists.)

- [ ] **Step 5: Win + round-played hooks**

In `server.js` find the round resolution (~line 553-561) where the winner is paid and `store.bumpWin` is called:
```js
      if (payout > 0) setBal(w.key, bal(w.key, room.cur) + payout, w.name, room.cur);
      store.bumpWin(w.key, w.name);
      gainXp(room, w.key, XP_WIN);
```
Add immediately after `gainXp(room, w.key, XP_WIN);`:
```js
      bumpQuest(room, w, "win");
```
Then, to count a played round for everyone, find where the round transitions to `roundover` (the start of this resolution block, where `room.phase` is set to `"roundover"` / the winner/draw is decided — it runs once per round). Add, guarded so it runs once per round:
```js
      for (const pp of room.players.values()) { store.bumpStat(pp.key, "games"); bumpQuest(room, pp, "games"); }
```
Place this on the single code path that ends a round (covers both win and draw). If win and draw are separate branches, place it in the shared parent before the branch.

- [ ] **Step 6: Login streak + init payload**

In `server.js`, in the join handler, after `addPlayer(room, player);` (~line 682) and before the `ws.send({t:"init", ...})`, add:
```js
        let streakResult = null;
        if (player.verified) {
          const today = quests.dayIndex(Date.now());
          const st = quests.nextStreak(store.getStreak(key), today);
          store.setStreak(key, { count: st.count, best: st.best, day: st.day });
          if (st.xpAwarded > 0) gainXp(room, key, st.xpAwarded);
          streakResult = { count: st.count, xpAwarded: st.xpAwarded };
        }
```
Then in the `ws.send(JSON.stringify({ t: "init", ... }))` object, add two fields before the closing `}))`:
```js
          quests: player.verified ? buildQuests(key, quests.dayIndex(Date.now())) : null,
          streak: streakResult,
```

- [ ] **Step 7: Run tests + syntax check**

Run: `npm test`
Expected: PASS. Then run: `node --check server.js` → no output (valid).

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat: wire stat/quest bumps into game hooks + grant login streak on join"
```

---

## Task 5: `POST /profile` HTTP endpoint (integration test with a forged signature)

**Files:**
- Modify: `server.js` (HTTP request handler, ~line 631-655)
- Test: extend `test/profile.test.js`

- [ ] **Step 1: Add the failing integration test**

Append to `test/profile.test.js`:

```js
const http = require("http");
const nacl = require("tweetnacl");
const bs58 = require("bs58").default || require("bs58");

function signedBody() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(Buffer.from(kp.publicKey));
  const ts = Date.now();
  const msg = new TextEncoder().encode(`KABOOMIES login\nwallet: ${wallet}\nts: ${ts}`);
  const sig = Array.from(nacl.sign.detached(msg, kp.secretKey));
  return { wallet, auth: { ts, sig } };
}

test("POST /profile returns a profile for a valid signature, 401 otherwise", async () => {
  const server = game.startServer(0);                 // ephemeral port
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;

  const post = (obj) => new Promise((resolve) => {
    const data = JSON.stringify(obj);
    const req = http.request({ host: "127.0.0.1", port, path: "/profile", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.end(data);
  });

  const ok = await post(signedBody());
  assert.strictEqual(ok.status, 200);
  const prof = JSON.parse(ok.body);
  assert.strictEqual(prof.quests.length, 3);
  assert.ok(prof.level >= 1);

  const bad = await post({ wallet: "nope", auth: { ts: Date.now(), sig: [1, 2, 3] } });
  assert.strictEqual(bad.status, 401);

  await new Promise(r => server.close(r));
});
```

> This requires the HTTP server to be startable on demand. Step 2 refactors the
> server bootstrap into an exported `startServer(port)` returning the http server.

- [ ] **Step 2: Refactor the bootstrap into `startServer` and export it**

In `server.js`, the bottom currently builds the server only when run directly. Locate the block that does `const server = http.createServer(...)`, attaches `new WebSocketServer({ server })`, the two `setInterval` loops, and `server.listen(PORT, ...)`. Wrap it in a function:

```js
function startServer(port) {
  const server = http.createServer((req, res) => {
    // ... existing handler body unchanged ...
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => { /* ... existing unchanged ... */ });
  setInterval(() => { /* ... existing tick loop unchanged ... */ }, TICK);
  setInterval(() => { /* ... existing snapshot loop unchanged ... */ }, SNAP);
  server.listen(port, () => console.log("KABOOMIES server on :" + port));
  return server;
}

// run only when executed directly (keeps the module importable for tests)
if (require.main === module) {
  store.init();
  startServer(process.env.PORT || 3000);
}
```

Add `startServer` to `module.exports`. (If `store.init()` is already called at the top-level of the original bootstrap, move it into the `require.main` guard so importing the module for tests does not read the real save file.)

- [ ] **Step 3: Add the `/profile` route inside the HTTP handler**

In `server.js`, at the very top of the `http.createServer((req, res) => { ... })` handler body (before the existing `url`-based GET routing), add:

```js
    if (req.method === "POST" && (req.url || "").split("?")[0] === "/profile") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        try {
          const m = JSON.parse(body || "{}");
          if (!(m.wallet && m.auth && auth.verify(m.wallet, m.auth.ts, m.auth.sig))) {
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "unauthorized" }));
          }
          const key = String(m.wallet).slice(0, 64);
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(buildProfile(key, store.getName(key))));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad_request" }));
        }
      });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the `/profile` integration test green (200 for valid sig, 401 for bad).

- [ ] **Step 5: Commit**

```bash
git add server.js test/profile.test.js
git commit -m "feat: POST /profile endpoint (verified) + testable startServer export"
```

---

## Task 6: Client — profile screen markup + styles

**Files:**
- Modify: `public/index.html` (HTML: add `screen-profile` + lobby `PROFIL` button; CSS)

- [ ] **Step 1: Add the lobby PROFIL button**

In `public/index.html`, in `#screen-lobby`, find the "back" control / header area (the same pattern as `#screen-create`'s back button). Add a profile button next to the lobby's back/header control:
```html
      <button class="wbtn ghost" id="profile-btn" onclick="openProfile()">👤 PROFIL</button>
```
(Match the surrounding markup/indentation of the lobby header so it sits inline with the existing controls.)

- [ ] **Step 2: Add the profile screen markup**

In `public/index.html`, after the `</section>` that closes `#screen-lobby` and before `#screen-game`, add:
```html
  <section class="screen" id="screen-profile">
    <button class="wbtn" id="profile-back" onclick="showScreen('lobby')" style="position:fixed;top:18px;left:18px;z-index:60">&lt; BACK</button>
    <div class="profile-wrap">
      <div class="profile-head">
        <canvas id="profile-av" width="150" height="182"></canvas>
        <div class="profile-id">
          <div class="profile-name" id="profile-name">Player</div>
          <div class="profile-wallet" id="profile-wallet"></div>
          <div class="profile-lvl"><b id="profile-lvl">Lv 1</b><span class="bar"><i id="profile-xpbar"></i></span><small id="profile-xp">0 / 100 XP</small></div>
        </div>
      </div>
      <div class="profile-grid" id="profile-stats"></div>
      <div class="profile-sec-title">🔥 LOGIN STREAK</div>
      <div class="profile-streak" id="profile-streak"></div>
      <div class="profile-sec-title">DAILY QUESTS</div>
      <div class="profile-quests" id="profile-quests"></div>
      <div class="profile-guest" id="profile-guest" style="display:none">Log in with your wallet to track stats and earn XP from daily quests.</div>
    </div>
  </section>
```

- [ ] **Step 3: Add the profile styles**

In `public/index.html`, inside `<style>` (near the lobby styles), add:
```css
  #screen-profile.active{position:fixed;inset:0;z-index:50;overflow:auto;
    background:#fff;background-image:linear-gradient(#ededed 1px,transparent 1px),linear-gradient(90deg,#ededed 1px,transparent 1px);background-size:26px 26px;}
  .profile-wrap{max-width:560px;margin:0 auto;padding:64px 16px calc(40px + env(safe-area-inset-bottom));}
  .profile-head{display:flex;gap:16px;align-items:center;background:#fff;border:3px solid var(--ink);box-shadow:5px 5px 0 var(--ink);padding:14px;margin-bottom:16px;}
  #profile-av{width:90px;height:auto;flex:none;image-rendering:auto;}
  .profile-name{font-family:var(--display);font-size:14px;margin-bottom:6px;}
  .profile-wallet{font-family:var(--body);font-size:16px;color:var(--grey);text-transform:uppercase;margin-bottom:8px;}
  .profile-lvl{font-family:var(--body);font-size:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .profile-lvl b{font-family:var(--display);font-size:10px;color:#b9821a;}
  .profile-lvl .bar{flex:1;min-width:120px;height:12px;border:2px solid var(--ink);background:#fff;}
  .profile-lvl .bar i{display:block;height:100%;background:var(--red);}
  .profile-lvl small{font-family:var(--body);font-size:14px;color:var(--grey);}
  .profile-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
  .profile-tile{background:#fff;border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:12px 8px;text-align:center;}
  .profile-tile .v{font-family:var(--display);font-size:14px;}
  .profile-tile .l{font-family:var(--body);font-size:14px;text-transform:uppercase;color:var(--grey);margin-top:6px;}
  .profile-sec-title{font-family:var(--display);font-size:9px;color:var(--red);margin:6px 0 10px;}
  .profile-streak{font-family:var(--body);font-size:18px;text-transform:uppercase;background:#fff;border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:10px 14px;margin-bottom:16px;}
  .profile-quests{display:flex;flex-direction:column;gap:10px;}
  .quest-row{background:#fff;border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:10px 12px;}
  .quest-row .top{display:flex;justify-content:space-between;gap:10px;font-family:var(--body);font-size:17px;text-transform:uppercase;}
  .quest-row .top b{font-family:var(--display);font-size:9px;color:#b9821a;}
  .quest-row.done{border-color:#43d17f;box-shadow:4px 4px 0 #43d17f;}
  .quest-row .bar{height:12px;border:2px solid var(--ink);background:#fff;margin-top:8px;}
  .quest-row .bar i{display:block;height:100%;background:#43d17f;}
  .profile-guest{font-family:var(--body);font-size:18px;text-transform:uppercase;color:var(--grey);text-align:center;padding:30px 10px;}
  @media(max-width:480px){.profile-grid{grid-template-columns:repeat(2,1fr);}}
```

- [ ] **Step 4: Verify it parses (preview)**

Reload the preview and confirm no console errors and the lobby still renders (the profile screen is hidden until navigated). Manual screenshot in Task 8.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: profile dashboard markup + styles"
```

---

## Task 7: Client — fetch/render profile, guest teaser, in-game toasts

**Files:**
- Modify: `public/index.html` (JS: `openProfile`, render helpers, ws `toast`/`init` handling)

- [ ] **Step 1: Add `openProfile()` + renderers**

In `public/index.html`, near the other screen/lobby JS (after `signLogin`/`joinMap`), add:
```js
async function openProfile(){
  showScreen("profile");
  const guest=$("profile-guest"), wrap=document.querySelector(".profile-wrap");
  const auth = await signLogin();
  if(!auth||!walletAddr){ guest.style.display="block";
    ["profile-stats","profile-quests","profile-streak"].forEach(id=>$(id).innerHTML="");
    $("profile-name").textContent="Guest"; $("profile-wallet").textContent=""; return; }
  guest.style.display="none";
  let p; try{ const r=await fetch("/profile",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({wallet:walletAddr,auth})}); if(!r.ok)throw 0; p=await r.json(); }
    catch(e){ _authCache=null; guest.style.display="block"; guest.textContent="Couldn't load profile — try again."; return; }
  renderProfile(p);
}
function renderProfile(p){
  $("profile-name").textContent=p.name||"Player";
  $("profile-wallet").textContent=walletAddr?(walletAddr.slice(0,4)+"…"+walletAddr.slice(-4)):"";
  $("profile-lvl").textContent="Lv "+p.level;
  const pct=p.xp.need?Math.min(100,Math.round(p.xp.into/p.xp.need*100)):0;
  $("profile-xpbar").style.width=pct+"%";
  $("profile-xp").textContent=p.xp.into+" / "+p.xp.need+" XP";
  const s=p.stats, tiles=[["Games",s.games],["Wins",s.wins],["Win %",s.winRate+"%"],
    ["Kills",s.kills],["Deaths",s.deaths],["K/D",s.kd],
    ["Best streak",p.streak.best],["Crates",s.crates],["Pickups",s.pickups]];
  $("profile-stats").innerHTML=tiles.map(t=>'<div class="profile-tile"><div class="v">'+t[1]+'</div><div class="l">'+t[0]+'</div></div>').join("");
  $("profile-streak").textContent=p.streak.count>0?("🔥 Day "+p.streak.count+" — keep it going!"):"No streak yet — play today to start one.";
  $("profile-quests").innerHTML=p.quests.map(q=>{
    const pc=Math.min(100,Math.round((q.prog/q.target)*100));
    return '<div class="quest-row'+(q.done?' done':'')+'"><div class="top"><span>'+(q.done?'✅ ':'')+q.label+'</span><b>+'+q.xp+' XP</b></div>'+
      '<div class="bar"><i style="width:'+pc+'%"></i></div><div class="top" style="margin-top:6px;color:#7a7a7a"><span>'+Math.min(q.prog,q.target)+' / '+q.target+'</span><span>'+(q.done?'DONE':'')+'</span></div></div>';
  }).join("");
  // draw avatar with the player's current skin
  const av=$("profile-av"); if(av&&typeof drawHero==="function"){ const real=ctx; ctx=av.getContext("2d");
    ctx.clearRect(0,0,av.width,av.height);
    drawHero(av.width/2,av.height*0.7,120,{base:playerSkin.base,skin:playerSkin.skin,clothes:playerSkin.clothes,house:playerSkin.house,roof:playerSkin.roof,hat:playerSkin.hat,hatCol:playerSkin.hatCol,face:1,phase:0,moving:false,sp:1,blink:0});
    ctx=real; }
}
```
(If `playerSkin` is not the correct variable name for the current customization in this file, use the same object `renderPreview()` reads.)

- [ ] **Step 2: Handle in-game toasts + join streak**

In `public/index.html`, find the WebSocket `onmessage` handler (where `d=JSON.parse(...)` and `d.t==="init"` is handled). Add a toast branch and a streak toast on init.

Add near the other `d.t===` branches:
```js
    if(d.t==="toast"){ pushFeed((d.kind==="quest"?"✅ ":"🔥 ")+d.label+" +"+d.xp+" XP","win"); sfx&&sfx("win"); return; }
```
In the `d.t==="init"` branch, after the existing init fields are applied, add:
```js
      if(d.streak&&d.streak.xpAwarded>0) pushFeed("🔥 Day "+d.streak.count+" streak +"+d.streak.xpAwarded+" XP","win");
```

- [ ] **Step 3: Verify it parses (preview)**

Reload the preview, open the browser console via the preview tools, confirm no JS errors, and that `openProfile` exists (`typeof openProfile`).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: fetch+render profile, guest teaser, in-game quest/streak toasts"
```

---

## Task 8: Manual verification (preview) + deploy

**Files:** none (verification + ship)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — quests, store, profile (incl. HTTP 200/401) suites all green.

- [ ] **Step 2: Preview — lobby + profile (guest)**

Start the preview server, open the lobby, click `👤 PROFIL`. Expected: profile screen shows the guest teaser (no wallet in preview). Screenshot in both `mobile` (portrait) and a landscape size; confirm layout matches the brutalist style and is scrollable.

- [ ] **Step 3: Preview — profile render with mock data**

Since a real wallet signature isn't available in preview, verify the rendering path by injecting a mock profile via `preview_eval`:
```js
showScreen('profile');
renderProfile({name:"Tester",level:4,xp:{into:120,need:280},
  stats:{games:37,wins:9,winRate:24,kills:88,deaths:51,kd:1.73,crates:140,pickups:62},
  streak:{count:3,best:7},
  quests:[{id:"win",label:"Win a round",target:1,xp:150,prog:1,done:true},
          {id:"kills",label:"Get 5 kills",target:5,xp:100,prog:3,done:false},
          {id:"crates",label:"Break 25 crates",target:25,xp:75,prog:25,done:true}]});
```
Expected: stat tiles, level bar, streak row, quest rows (2 done = green, 1 in-progress bar) all render cleanly. Screenshot mobile portrait + landscape.

- [ ] **Step 4: Preview — in-game toast**

Join a room, then simulate a toast via `preview_eval`:
```js
pushFeed("✅ Win a round +150 XP","win");
```
Expected: a green killfeed-style toast appears. Screenshot.

- [ ] **Step 5: Push to main + confirm deploy**

```bash
git push origin HEAD:main
git -C "C:/Users/User/projects/kaboomies" merge --ff-only origin/main
```
Then poll the live site until the new code is served (look for `screen-profile` / `profile-btn` in the served HTML), confirming Railway redeployed.

---

## Self-review notes

- **Spec coverage:** stats persistence (T2), quest pool + daily pick + streak math (T1), hooks for kills/deaths/crates/pickups/win/games (T4), streak grant on join (T4), auto-grant + toast (T3/T4/T7), `POST /profile` verified (T5), lobby button + profile screen + guest teaser (T6/T7), in-game toasts (T7), backward-compat defaults (T2), tests (T1/T2/T3/T5), preview verification (T8). All covered.
- **Type consistency:** quest object shape `{id,label,target,xp,prog,done}` is identical in `buildQuests` (T3) and the client renderer (T7); profile shape from `buildProfile` (T3) matches `renderProfile` (T7) and the tests (T3/T5); `getQuestState`/`setQuestState`/`getStreak`/`setStreak`/`getStats`/`bumpStat`/`getWins`/`getName` names match between `store.js` (T2) and `server.js` (T3/T4).
- **Known soft spots flagged for the implementer:** exact line of the crush-death `alive=false` (T4 Step 4) and the single once-per-round resolution path (T4 Step 5) must be located in-context; the client customization variable may be `playerSkin` or whatever `renderPreview()` reads (T7 Step 1).
