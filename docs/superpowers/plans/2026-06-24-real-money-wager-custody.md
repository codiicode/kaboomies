# Real-money wager economy + $KABOOM custody — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete real-money $KABOOM system — a 5-round wager game (locked buy-in pot + per-death loot) and on-chain deposit/withdraw custody — fully working but OFF behind `REAL_MONEY_ENABLED`.

**Architecture:** Extend the existing server game loop and `"real"` currency balance for the wager economy; isolate all chain/treasury-key code in a new `custody.js`. Everything inert unless `KABOOM_MINT` + `TREASURY_SECRET` + `SOLANA_RPC` are set. Pure logic is unit-tested; chain code is tested against a mock.

**Tech Stack:** Node.js, `ws`, `@solana/web3.js`, `@solana/spl-token`, node:test.

**Spec:** `docs/superpowers/specs/2026-06-24-real-money-wager-custody-design.md`

**Conventions:** tests run with `npm test` (`node --test test/*.test.js`). Commit after each green step. Numbers (tiers, rake, caps) are constants near the top of their module so they're tunable.

---

## Phase 1 — Wager game economy (server, gated, no chain)

### Task 1: Tier config on the 3 maps

**Files:**
- Modify: `server.js` (the `MAPS` object — add wager params to `casual`, `brawl`, `highroller`)

- [ ] **Step 1: Add wager config to MAPS**

For each real-money tier add `wager:true`, `buyIn`, `deathStake`, `rake`. Replace the old per-round `ante` model. Example (match existing MAPS shape):

```js
// in MAPS:
casual:     { ...existing, wager: true, buyIn: 500,   deathStake: 100,   rake: 0.05 },
brawl:      { ...existing, wager: true, buyIn: 5000,  deathStake: 1000,  rake: 0.05 },
highroller: { ...existing, wager: true, buyIn: 50000, deathStake: 10000, rake: 0.05 },
```

Note: `wager:true` maps are only ever *joined* in real mode (server already blocks real joins unless `REAL_MONEY_ENABLED`). In training (`mode:"play"`) these same maps run with NO wager behavior — see Task 5's `isWagerGame(room)` which is false unless `room.cur === "real"`.

- [ ] **Step 2: Commit**

```bash
git add server.js && git commit -m "feat(wager): tier config (buyIn/deathStake/rake) on the 3 maps"
```

---

### Task 2: GAME_ROUNDS constant + per-game round-win state

**Files:**
- Modify: `server.js` (constants near other game consts; room init in `makeRoom` + `newRound`)
- Test: `test/wager.test.js` (create)

- [ ] **Step 1: Write failing test for game state init**

```js
const test = require("node:test");
const assert = require("node:assert");
const s = require("../server.js");

test("a real-money room starts a game: round 1 of GAME_ROUNDS, empty round-wins", () => {
  const room = s.makeRoom("brawl", "real");
  assert.strictEqual(room.cur, "real");
  assert.strictEqual(room.gameRound, 1);
  assert.strictEqual(s.GAME_ROUNDS, 5);
  assert.deepStrictEqual(room.roundWins instanceof Map ? [...room.roundWins] : room.roundWins, []);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/wager.test.js` → FAIL (`GAME_ROUNDS`/`gameRound` undefined).

- [ ] **Step 3: Implement**

Add `const GAME_ROUNDS = 5;` near the other consts and export it. In `makeRoom`'s returned object and in `newRound`, initialize game state. `gameRound`/`roundWins`/`pot` reset only at GAME start, not every round (see Task 4). For now add to `makeRoom`: `gameRound: 1, roundWins: new Map(), pot: 0,` and ensure `roundWins` is a `Map` keyed by player id → wins.

- [ ] **Step 4: Run, expect pass.** `node --test test/wager.test.js`

- [ ] **Step 5: Commit**

```bash
git add server.js test/wager.test.js && git commit -m "feat(wager): GAME_ROUNDS + per-game round-win state"
```

---

### Task 3: `isWagerGame(room)` helper

**Files:**
- Modify: `server.js`
- Test: `test/wager.test.js`

- [ ] **Step 1: Failing test**

```js
test("isWagerGame is true only for real-currency wager maps", () => {
  assert.strictEqual(s.isWagerGame(s.makeRoom("brawl", "real")), true);
  assert.strictEqual(s.isWagerGame(s.makeRoom("brawl", "play")), false); // training on same map
  assert.strictEqual(s.isWagerGame(s.makeRoom("daily", "play")), false);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

```js
function isWagerGame(room) {
  const cfg = MAPS[room.mapId];
  return !!(room && room.cur === "real" && cfg && cfg.wager);
}
```
Export it.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(wager): isWagerGame helper`

---

### Task 4: Buy-in locked into pot once per game (not per round)

**Files:**
- Modify: `server.js` (replace `roundAnte`; add `chargeBuyIn(room, player)`; wire into join + game start)
- Test: `test/wager.test.js`

- [ ] **Step 1: Failing test**

```js
test("buy-in is charged once per game and locked into the pot", () => {
  const room = s.makeRoom("brawl", "real");           // buyIn 5000
  const p = s.addPlayer(room, { id: 1, key: "w1", name: "A", verified: true });
  s.store.setBalance("w1", 12000, "A", "real");
  s.chargeBuyIn(room, p);
  assert.strictEqual(s.store.getBalance("w1", "real"), 7000); // 12000 - 5000
  assert.strictEqual(room.pot, 5000);
  assert.strictEqual(p.boughtIn, true);
  // charging again in the same game is a no-op
  s.chargeBuyIn(room, p);
  assert.strictEqual(room.pot, 5000);
});
```
(Use whatever `store` balance API exists — confirm `getBalance/setBalance(key,amt,name,cur)` signatures in `store.js`; adapt names if different.)

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

Replace `roundAnte` with a per-game buy-in. `boughtIn` resets only when a NEW game starts (Task 6), not per round.

```js
function chargeBuyIn(room, p) {
  if (!isWagerGame(room) || p.bot || p.boughtIn) return;
  const cfg = MAPS[room.mapId];
  if (bal(p.key, room.cur) >= cfg.buyIn) {
    setBal(p.key, bal(p.key, room.cur) - cfg.buyIn, p.name, room.cur);
    room.pot += cfg.buyIn;
    p.boughtIn = true;
    store.ledger && store.ledger(p.key, -cfg.buyIn, "buyin", room.cur); // Task 13 adds ledger; guard until then
  } else {
    p.boughtIn = false; p.alive = false; // can't cover buy-in -> can't play
  }
}
```
Add `p.boughtIn = false` to `resetPlayer`. Remove the old `roundAnte` call sites; call `chargeBuyIn` for each human at game start and on join-mid-game (Task 6 / join handler).

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(wager): once-per-game buy-in locked into pot`

---

### Task 5: Death drops loot in wager games (instead of direct transfer)

**Files:**
- Modify: `server.js` (`settleDeath`)
- Test: `test/wager.test.js`

- [ ] **Step 1: Failing test**

```js
test("in a wager game, death drops the stake as loot (not a direct transfer)", () => {
  const room = s.makeRoom("brawl", "real");           // deathStake 1000
  const v = s.addPlayer(room, { id: 1, key: "v", name: "V", verified: true });
  const k = s.addPlayer(room, { id: 2, key: "k", name: "K", verified: true });
  s.store.setBalance("v", 3000, "V", "real");
  v.x = 5 * s.TILE + s.TILE / 2; v.y = 5 * s.TILE + s.TILE / 2;
  s.settleDeath(room, v, k);
  assert.strictEqual(s.store.getBalance("v", "real"), 2000);       // victim lost 1000
  assert.strictEqual(s.store.getBalance("k", "real"), 0);          // killer did NOT get it directly
  assert.ok(room.drops.some(d => d.a === 1000));                   // it's on the ground as loot
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

In `settleDeath`, branch: wager game → debit victim and push a drop at the victim's tile; else keep the existing training behavior (direct transfer).

```js
function settleDeath(room, victim, killer) {
  victim.streak = 0;
  if (!isRanked(room) || victim.bot) return;
  if (isWagerGame(room)) {
    const stake = MAPS[room.mapId].deathStake;
    const lost = Math.min(stake, bal(victim.key, room.cur));
    if (lost <= 0) return;
    setBal(victim.key, bal(victim.key, room.cur) - lost, victim.name, room.cur);
    const c = Math.round((victim.x - TILE / 2) / TILE), r = Math.round((victim.y - TILE / 2) / TILE);
    room.drops.push({ c, r, a: lost });
    return;
  }
  // ... existing training transfer (unchanged) ...
}
```
The existing pickup code in `movePlayer` (`room.drops` loop: `setBal(pl.key, bal + drops[i].a)`) already credits whoever grabs it — verify it runs for wager rooms (it should; it's unconditional). Loot pickup credit is therefore already wired.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(wager): death drops stake as loot in wager games`

---

### Task 6: 5-round game loop + game-end settlement (pot − rake, tie split)

**Files:**
- Modify: `server.js` (`maybeEndRound` → tally round win; add `endGame(room)` + `startGame(room)`; round advance)
- Test: `test/wager.test.js`

- [ ] **Step 1: Failing test**

```js
test("after GAME_ROUNDS, the most-round-wins player takes pot minus rake", () => {
  const room = s.makeRoom("brawl", "real");
  const a = s.addPlayer(room, { id: 1, key: "a", name: "A", verified: true });
  const b = s.addPlayer(room, { id: 2, key: "b", name: "B", verified: true });
  room.pot = 10000;                          // pretend 2 buy-ins of 5000
  room.roundWins = new Map([[1, 3], [2, 2]]); // A won 3, B won 2
  room.gameRound = s.GAME_ROUNDS;            // last round
  s.store.setBalance("a", 0, "A", "real");
  s.endGame(room);
  // 10000 - 5% rake = 9500 to A
  assert.strictEqual(s.store.getBalance("a", "real"), 9500);
  assert.strictEqual(room.pot, 0);
});

test("tie splits the pot evenly", () => {
  const room = s.makeRoom("brawl", "real");
  const a = s.addPlayer(room, { id: 1, key: "a", name: "A", verified: true });
  const b = s.addPlayer(room, { id: 2, key: "b", name: "B", verified: true });
  room.pot = 10000; room.roundWins = new Map([[1, 2], [2, 2]]);
  s.store.setBalance("a", 0, "A", "real"); s.store.setBalance("b", 0, "B", "real");
  s.endGame(room);
  // 9500 split -> 4750 each
  assert.strictEqual(s.store.getBalance("a", "real"), 4750);
  assert.strictEqual(s.store.getBalance("b", "real"), 4750);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

In `maybeEndRound`, when a round ends in a wager game: increment `room.roundWins` for the survivor, then if `room.gameRound >= GAME_ROUNDS` call `endGame(room)`, else `room.gameRound++` and start the next round (existing round-restart path). Keep training behavior unchanged when `!isWagerGame`.

```js
function endGame(room) {
  const cfg = MAPS[room.mapId];
  const rake = Math.round(room.pot * (cfg.rake || 0));
  const prize = Math.max(0, room.pot - rake);
  let max = -1; for (const w of room.roundWins.values()) if (w > max) max = w;
  const winners = [...room.players.values()].filter(p => !p.bot && (room.roundWins.get(p.id) || 0) === max && max > 0);
  if (winners.length && prize > 0) {
    const share = Math.floor(prize / winners.length);
    for (const w of winners) { setBal(w.key, bal(w.key, room.cur) + share, w.name, room.cur); store.bumpWin && store.bumpWin(w.key, w.name); }
  }
  room.pot = 0;
  pushEvent(room, { k: "gameover", winners: winners.map(w => w.name), prize });
  startGame(room); // reset gameRound=1, roundWins, boughtIn=false, re-charge buy-ins
}
function startGame(room) {
  room.gameRound = 1; room.roundWins = new Map();
  for (const p of room.players.values()) p.boughtIn = false;
  for (const p of room.players.values()) if (!p.bot) chargeBuyIn(room, p);
}
```
Call `startGame(room)` for a wager room where the first game begins (e.g., in `newRound`/first ranked round). Guard all of this behind `isWagerGame(room)`.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(wager): 5-round game loop + pot payout with rake + tie split`

---

### Task 7: Sweep uncollected loot into the pot at round/arena end

**Files:**
- Modify: `server.js` (`maybeEndRound` wager branch, before advancing round)
- Test: `test/wager.test.js`

- [ ] **Step 1: Failing test**

```js
test("uncollected loot is swept into the pot when a round ends", () => {
  const room = s.makeRoom("brawl", "real");
  s.addPlayer(room, { id: 1, key: "a", name: "A", verified: true });
  s.addPlayer(room, { id: 2, key: "b", name: "B", verified: true });
  room.pot = 5000; room.drops = [{ c: 3, r: 3, a: 700 }, { c: 4, r: 4, a: 300 }];
  s.sweepLoot(room);
  assert.strictEqual(room.pot, 6000);
  assert.strictEqual(room.drops.length, 0);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

```js
function sweepLoot(room) {
  if (!isWagerGame(room)) return;
  for (const d of room.drops) room.pot += d.a;
  room.drops = [];
}
```
Call `sweepLoot(room)` in the wager branch of `maybeEndRound` right when a round ends (and once more inside `endGame` defensively). Export it.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(wager): sweep uncollected loot into the pot at round end`

---

### Task 8: Join requires balance ≥ buyIn + deathStake; snapshot carries pot/round

**Files:**
- Modify: `server.js` (join handler ~line 900-930; `snapshot`)
- Test: `test/wager.test.js`

- [ ] **Step 1: Failing test**

```js
test("snapshot exposes pot, gameRound and GAME_ROUNDS for wager rooms", () => {
  const room = s.makeRoom("brawl", "real");
  s.addPlayer(room, { id: 1, key: "a", name: "A", verified: true });
  room.pot = 5000; room.gameRound = 2;
  const snap = s.snapshot(room);
  assert.strictEqual(snap.pot, 5000);
  assert.strictEqual(snap.gr, 2);
  assert.strictEqual(snap.gn, s.GAME_ROUNDS);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

Add to the `snapshot` return: `gr: room.gameRound, gn: GAME_ROUNDS` (pot already present). In the join handler, before admitting a real-money player, require `bal(key,"real") >= cfg.buyIn + cfg.deathStake`; otherwise `ws.send({t:"blocked", reason:"insufficient"})` and return. (Confirm exact join-handler shape; mirror existing `blocked` responses.)

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(wager): join gate + pot/round in snapshot`

---

## Phase 2 — On-chain custody (`custody.js`, gated, mock-tested)

### Task 9: Real balance ledger in store.js

**Files:**
- Modify: `store.js` (add `ledger(key, delta, kind, cur)` append-only log + `getLedger(key)`)
- Test: `test/custody.test.js` (create)

- [ ] **Step 1: Failing test**

```js
const test = require("node:test");
const assert = require("node:assert");
const store = require("../store.js");

test("ledger records append-only entries per wallet", () => {
  store.ledger("wX", -5000, "buyin", "real");
  store.ledger("wX", +9500, "payout", "real");
  const l = store.getLedger("wX");
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].delta, -5000);
  assert.strictEqual(l[1].kind, "payout");
  assert.ok(typeof l[0].ts === "number");
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

In `store.js`, add `mem.ledger = mem.ledger || {}`. `ledger(key,delta,kind,cur)` pushes `{ts, delta, kind, cur}` (ts via `Date.now()`), caps length per wallet (e.g. last 200), `saveSoon()`. `getLedger(key)` returns the array (or `[]`). Export both. (Wire the guarded `store.ledger` calls added in Tasks 4/6 to now exist.)

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(custody): append-only balance ledger in store`

---

### Task 10: custody.js skeleton + config gating

**Files:**
- Create: `custody.js`
- Modify: `package.json` (add `@solana/web3.js`, `@solana/spl-token`)
- Test: `test/custody.test.js`

- [ ] **Step 1: Failing test**

```js
const custody = require("../custody.js");
test("custody is disabled unless all env vars are set", () => {
  assert.strictEqual(custody.enabled(), false); // no env in test
  const r = custody.config();
  assert.strictEqual(r.MIN_WITHDRAW > 0, true);
});
```

- [ ] **Step 2: Run, expect fail** (`Cannot find module '../custody.js'`).

- [ ] **Step 3: Implement**

Create `custody.js`. `enabled()` returns `!!(process.env.KABOOM_MINT && process.env.TREASURY_SECRET && process.env.SOLANA_RPC)`. Lazy-`require` `@solana/*` only inside functions that need the chain (so tests + the gated-off server never load them). `config()` returns tunable caps: `MIN_WITHDRAW`, `MAX_PER_TX`, `DAILY_CAP`, `COOLDOWN_MS`, `PAUSED` (env flag). Run `npm install @solana/web3.js @solana/spl-token`.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(custody): module skeleton + env gating + caps`

---

### Task 11: Deposit crediting (idempotent, by sender) — mock chain

**Files:**
- Modify: `custody.js` (`creditDeposit({sig, fromWallet, amount}, store)`)
- Test: `test/custody.test.js`

- [ ] **Step 1: Failing test**

```js
test("a deposit credits the sender once; replaying the same signature is a no-op", () => {
  store.setBalance("dep1", 0, null, "real");
  const ok1 = custody.creditDeposit({ sig: "SIGA", fromWallet: "dep1", amount: 1000 }, store);
  const ok2 = custody.creditDeposit({ sig: "SIGA", fromWallet: "dep1", amount: 1000 }, store); // replay
  assert.strictEqual(ok1, true);
  assert.strictEqual(ok2, false);
  assert.strictEqual(store.getBalance("dep1", "real"), 1000);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

`creditDeposit` checks a persisted seen-signature set (via `store` — add `store.markSig(sig)`/`store.seenSig(sig)` returning false if new+marks, true if already seen). If new: `store.setBalance(fromWallet, getBalance+amount, ...,"real")`, `store.ledger(fromWallet, +amount, "deposit", "real")`, return true. If seen: return false. The actual chain watcher (Task 12) calls this; here it's unit-tested directly with a fake event.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(custody): idempotent deposit crediting`

---

### Task 12: Deposit watcher (polls RPC; lazy chain; only when enabled)

**Files:**
- Modify: `custody.js` (`startWatcher(store)` — poll loop), `server.js` (call `custody.startWatcher(store)` in `startServer` only if `custody.enabled()`)
- Test: `test/custody.test.js` (test the parse helper, not the network)

- [ ] **Step 1: Failing test for the transfer parser**

```js
test("parseIncoming extracts {sig, fromWallet, amount} for KABOOM transfers to treasury", () => {
  const fake = custody._fakeTx({ sig: "S1", from: "walletA", to: "TREASURY_ATA", mint: "MINT", amount: 2500 });
  const out = custody.parseIncoming(fake, { treasuryAta: "TREASURY_ATA", mint: "MINT" });
  assert.deepStrictEqual(out, { sig: "S1", fromWallet: "walletA", amount: 2500 });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

`parseIncoming(tx, {treasuryAta, mint})` reads a parsed transaction's token balance deltas / instructions, returns `{sig, fromWallet, amount}` for inbound transfers of `mint` to `treasuryAta`, else `null`. Add `_fakeTx(...)` test helper that builds the minimal shape `parseIncoming` reads. `startWatcher(store)` (only meaningful when `enabled()`): `setInterval` polling `getSignaturesForAddress(treasuryAta)`, fetch new parsed txs, `parseIncoming` → `creditDeposit`. Guard so it never starts/loads chain libs in tests or when disabled.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(custody): deposit watcher + transfer parser`

---

### Task 13: Withdraw with safeguards (debit-first, caps, idempotency) — mock send

**Files:**
- Modify: `custody.js` (`withdraw({wallet, amount, idemKey}, store, sendFn)`)
- Test: `test/custody.test.js`

- [ ] **Step 1: Failing tests**

```js
test("withdraw debits first, then sends, and is idempotent", async () => {
  store.setBalance("wd1", 20000, null, "real");
  const sends = [];
  const sendFn = async ({ to, amount }) => { sends.push({ to, amount }); return "TXSIG1"; };
  const r1 = await custody.withdraw({ wallet: "wd1", amount: 5000, idemKey: "k1" }, store, sendFn);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(store.getBalance("wd1", "real"), 15000);
  assert.strictEqual(sends.length, 1);
  // replay same idemKey -> no double send
  const r2 = await custody.withdraw({ wallet: "wd1", amount: 5000, idemKey: "k1" }, store, sendFn);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(store.getBalance("wd1", "real"), 15000);
});

test("withdraw rejects below min, above max-per-tx, over balance, and rolls back on send failure", async () => {
  store.setBalance("wd2", 1000000, null, "real");
  const cfg = custody.config();
  assert.strictEqual((await custody.withdraw({ wallet: "wd2", amount: cfg.MIN_WITHDRAW - 1, idemKey: "a" }, store, async()=>"x")).ok, false);
  assert.strictEqual((await custody.withdraw({ wallet: "wd2", amount: cfg.MAX_PER_TX + 1, idemKey: "b" }, store, async()=>"x")).ok, false);
  assert.strictEqual((await custody.withdraw({ wallet: "nope", amount: cfg.MIN_WITHDRAW, idemKey: "c" }, store, async()=>"x")).ok, false);
  const before = store.getBalance("wd2", "real");
  const failSend = async () => { throw new Error("rpc down"); };
  const rb = await custody.withdraw({ wallet: "wd2", amount: cfg.MIN_WITHDRAW, idemKey: "d" }, store, failSend);
  assert.strictEqual(rb.ok, false);
  assert.strictEqual(store.getBalance("wd2", "real"), before); // rolled back
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

`withdraw({wallet, amount, idemKey}, store, sendFn=realSend)`:
1. If `config().PAUSED` → `{ok:false, reason:"paused"}`.
2. Validate `amount >= MIN_WITHDRAW`, `<= MAX_PER_TX`, integer > 0.
3. Idempotency: if `store.seenSig("wd:"+idemKey)` already → return cached `{ok:true, replay:true}`.
4. Daily cap: sum today's withdraw ledger for wallet + amount ≤ `DAILY_CAP`, else reject.
5. Balance check `getBalance(wallet,"real") >= amount`, else reject.
6. **Debit first**: `setBalance(wallet, bal-amount,...,"real")`, `ledger(wallet,-amount,"withdraw","real")`, mark idemKey.
7. `try { sig = await sendFn({to:wallet, amount}); } catch { rollback: setBalance(wallet, bal+amount,...), ledger(+amount,"withdraw-rollback"); return {ok:false, reason:"send_failed"}; }`
8. Return `{ok:true, sig}`.
`realSend` (lazy chain) builds + signs the SPL transfer treasury→wallet with `TREASURY_SECRET` (create recipient ATA if missing) and submits — only used when not under test.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(custody): guarded withdraw (debit-first, caps, idempotent, rollback)`

---

### Task 14: HTTP endpoints — `/wallet`, `/deposit-info`, `/withdraw` (gated)

**Files:**
- Modify: `server.js` (HTTP request handler; reuse `auth.verify` like `/profile`)
- Test: `test/custody.test.js` (call the exported route handlers directly, or via `startServer` + fetch as `profile.test.js` does)

- [ ] **Step 1: Failing test (disabled path)**

```js
test("withdraw endpoint refuses when custody is disabled", async () => {
  const res = await s.handleWithdraw({ wallet: "w", amount: 100, auth: {/*valid*/}, idemKey: "z" });
  assert.strictEqual(res.error, "disabled");
});
```
(Adapt to however routes are structured; mirror the `/profile` POST pattern + its auth check.)

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

- `GET/POST /wallet` → `{ balance: bal(key,"real"), ledger: store.getLedger(key) }` (auth required).
- `POST /deposit-info` → `{ treasury: <treasury pubkey>, mint: KABOOM_MINT }` when enabled, else `{error:"disabled"}`.
- `POST /withdraw` → verify auth (`auth.verify`), then `custody.enabled()` else `{error:"disabled"}`, then `custody.withdraw(...)`. Apply the existing rate-limiter.
All return `{error:"disabled"}` when `!custody.enabled()`.

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** `feat(custody): /wallet, /deposit-info, /withdraw endpoints (gated)`

---

## Phase 3 — Client UI

### Task 15: Wallet panel (deposit address + withdraw + balance/history)

**Files:**
- Modify: `public/index.html` (new wallet panel markup + CSS + fetch wiring)

- [ ] **Step 1: Markup + styles** — add a `#wallet` panel reachable from the lobby (real-money only): shows real $KABOOM balance, a **Deposit** block (fetch `/deposit-info`, show treasury address + copy button + "I've sent it" hint), a **Withdraw** form (amount → POST `/withdraw` with signed auth), and a history list (`/wallet` ledger). Match existing panel styles.
- [ ] **Step 2: Wiring** — `signLogin()` for auth on `/wallet` and `/withdraw`; render balance + ledger; disabled-state copy when `/deposit-info` returns `disabled`.
- [ ] **Step 3: Verify in preview** — panel renders, disabled state shows (no env), no console errors. (Real flow can't run without env.)
- [ ] **Step 4: Commit** `feat(custody): client wallet panel (deposit/withdraw/history)`

---

### Task 16: In-game pot + Round X/5 HUD and game-end screen

**Files:**
- Modify: `public/index.html` (HUD + snapshot handling for `gr`/`gn`; game-end overlay on `gameover` event)

- [ ] **Step 1:** Read `m.gr`/`m.gn` from snapshots; show **Round X/5** and the **live pot** in the HUD for wager rooms (hidden otherwise). Show your round-wins.
- [ ] **Step 2:** Handle the `gameover` event (from `endGame`) → overlay with winner(s) + prize; then the next game's buy-in notice.
- [ ] **Step 3: Verify in preview** (training shows no pot/round HUD; structure parses; no console errors).
- [ ] **Step 4: Commit** `feat(wager): in-game pot + round HUD + game-over screen`

---

### Task 17: Lobby tier cards show buy-in / death stake / live pot

**Files:**
- Modify: `public/index.html` (`renderArenas` real-money branch)

- [ ] **Step 1:** In the real-money branch of `renderArenas`, show each tier's buy-in, death stake, and live pot (from the maps payload — extend the `/` maps response to include `buyIn`/`deathStake` for wager maps).
- [ ] **Step 2:** Modify `server.js` `/` handler to include `buyIn`, `deathStake` in each wager map entry.
- [ ] **Step 3: Verify in preview** (real-money tab shows the three tiers with numbers; training still shows single TRAINING GROUND).
- [ ] **Step 4: Commit** `feat(wager): lobby tier cards show buy-in/stake/pot`

---

## Phase 4 — Integration, gating, deploy

### Task 18: Full gating sweep + integration test

**Files:**
- Test: `test/wager.test.js`, `test/custody.test.js`
- Modify: `server.js` / `custody.js` as needed

- [ ] **Step 1:** Integration test: with env unset, a real-money join is blocked (existing `real_soon`) and `/withdraw` returns `disabled`; a simulated 2-human wager game (drive `tick`) runs 5 rounds and pays the winner pot−rake. Assert balances.
- [ ] **Step 2:** Run full suite `npm test` → all green (existing 45 + new).
- [ ] **Step 3:** `node --check server.js && node --check custody.js`.
- [ ] **Step 4: Commit** `test: wager + custody integration & gating`

---

### Task 19: Verify in preview + deploy

- [ ] **Step 1:** `preview_start`; confirm training unaffected (single TRAINING GROUND, free play), real-money tab shows tiers + wallet panel in disabled state, no console errors.
- [ ] **Step 2:** Merge/push to `main` (per the always-deploy rule). Poll live for a marker.
- [ ] **Step 3:** Confirm live; training still works; real money still gated off.
- [ ] **Step 4:** Note in summary: **activation still requires the three env vars + legal review.**

---

## Self-review notes
- Spec A (game/economy) → Tasks 1-8, 16-17. Spec B (custody) → Tasks 9-15. Spec C (UI) → 15-17. Spec D (tests/gating) → every task's tests + 18-19.
- Confirm exact `store` balance API names (`getBalance/setBalance/getBal/setBal`, currency arg) in Task 9 before Phase 1 tests rely on them; adapt test calls to the real signatures.
- All wager behavior guarded by `isWagerGame(room)` (true only when `room.cur==="real"` AND map has `wager`), so training on the same maps is never affected.
- Open plan-time decisions (from spec): auto-create recipient ATA on withdraw (Task 13 — yes, create if missing); ledger cap 200 entries (Task 9); watcher poll interval (Task 12 — 8s, confirmed depth).
