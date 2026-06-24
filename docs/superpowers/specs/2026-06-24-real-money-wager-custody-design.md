# Real-money wager economy + $KABOOM custody — design

**Date:** 2026-06-24
**Status:** Approved (design); implementation gated behind `REAL_MONEY_ENABLED`.

## ⚠️ Scope & gating

This builds the **complete real-money system** (in-game wager economy **and** on-chain
$KABOOM custody) so it is **ready but OFF**. It stays fully behind the existing gate:
real-money joins and all custody endpoints are inert unless `KABOOM_MINT`,
`TREASURY_SECRET`, and `SOLANA_RPC` are all set. Flipping it live is a **regulated
activity** (wagering + token; e.g. Sweden / Spelinspektionen) and **must be legally
reviewed before activation** — building it does not activate it.

Training mode (free chips) is completely unaffected by everything here.

---

## Section A — Game structure & money flow (in-game economy)

### A game = 5 rounds
- A **game** is **5 rounds** on the same map with the same players.
- Players play all 5 rounds. The **game winner = most round-wins** across the 5 rounds.
- **Tie** (equal round-wins) → the pot is **split evenly** among the tied players.
- Round = the existing last-survivor round (`maybeEndRound`). After round 5, the game
  settles and a fresh game starts (new buy-ins).

### Stake tiers (the 3 existing arenas become real-money tiers — numbers tunable)
| Tier         | map id       | Death stake (loot drop) | Buy-in (→ pot) |
|--------------|--------------|-------------------------|----------------|
| Rookie       | `casual`     | 100                     | 500            |
| Brawl        | `brawl`      | 1 000                   | 5 000          |
| High Roller  | `highroller` | 10 000                  | 50 000         |

### Two separate money pools (the key invariant)
1. **Buy-in → winner's pot (locked, untouchable).** On joining a game the buy-in is
   moved from the player's balance into `room.pot`. It is **never** touched by deaths,
   never refunded. The pot is **always** funded = sum of all players' buy-ins.
2. **Death stake → loot (from the player's own balance).** Independent of the pot.

### Money flow
1. **Deposit** $KABOOM once → real account balance (withdraw anytime). (Section B.)
2. **Join a game** → balance must be ≥ `buy_in + death_stake` (cover the buy-in plus at
   least one death). Buy-in is locked into `room.pot`.
3. **On death** → `min(death_stake, balance)` is removed from the victim's balance and
   **dropped as a $KABOOM loot coin** at the death tile (reuse the existing `room.drops`
   system). **First player to walk over it keeps it** (added to their balance). It does
   not matter who landed the kill; self/environment deaths still drop loot.
4. **Round / arena (sudden-death) end** → any loot still on the ground is **swept into
   `room.pot`** (nothing is burned).
5. **Game end (after round 5)** → game winner receives **`pot − rake`** (rake default
   **5%**, tunable per map). Tie → split evenly (remainder dust → pot/house).
6. **Disconnect mid-game** → forfeit remaining rounds; balance stays as-is; **buy-in is
   not refunded** (matches the established "disconnect = you lose your stake" rule).
7. **Broke mid-game** (balance < death stake) → keep playing; on death drop only what's
   left (possibly 0).

### Worked example (Rookie, 4 players, buy-in 500 / death 100)
- Pot starts at 4 × 500 = **2 000** (locked).
- A player dies all 5 rounds → drops 5 × 100 = 500 of *their balance* as loot; pot stays 2 000.
- Winner takes 2 000 − 5% = **1 900** + any loot grabbed. The pot can never be drained by deaths.

---

## Section B — On-chain custody (`custody.js`)

Isolated module; all treasury-key / chain code lives here for auditability. Uses
`@solana/web3.js` + `@solana/spl-token`. Inert unless `REAL_MONEY_ENABLED`.

### Config (env)
- `KABOOM_MINT` — the $KABOOM SPL mint.
- `TREASURY_SECRET` — base58 secret key of the treasury wallet (**secret**).
- `SOLANA_RPC` — RPC endpoint.

### Real balance accounting
- The real balance already exists in `store.js` under the `"real"` currency
  (`bal(key,"real")` / `setBal(..., "real")`). Custody only ever moves balance via these.
- A persistent **ledger / audit log** records every credit (deposit) and debit
  (withdraw/buy-in/payout/loot) with timestamp, wallet, amount, on-chain signature.

### Deposit (credit via sender wallet — no memo)
- UI shows the **treasury deposit address** + an "I've sent it" button.
- A **deposit watcher** polls the treasury token account's recent signatures
  (`getSignaturesForAddress`), parses incoming SPL transfers of `KABOOM_MINT`, and
  **credits the sender's wallet** (sender owner == the player's account key → automatic
  attribution).
- **Idempotent**: processed tx signatures are persisted; a signature is credited at most
  once; survives restarts. Confirmed-commitment only.

### Withdraw (automatic, capped)
- Signed request (verified wallet only) → check balance → **debit first** → build & sign
  treasury→recipient SPL transfer with `TREASURY_SECRET` → submit → confirm.
- On send/confirm failure → **roll back the debit** (or hold as `pending` and reconcile);
  never silently lost.
- **Safeguards (no manual review per user's choice — caps are the anti-drain):**
  - `min_withdraw` (dust floor) — default 1× Rookie buy-in.
  - `max_per_tx` — default 5× High-Roller buy-in.
  - `daily_cap_per_wallet` — default 10× High-Roller buy-in.
  - cooldown / rate-limit per wallet.
  - **idempotency key** per withdrawal (no double-send on retry).
  - treasury-balance check before attempting.
  - recipient ATA: create if missing (or require existing) — decided in plan.
  - **global pause switch** (env/flag) to halt all withdrawals instantly.
  - full **audit log**.

---

## Section C — UI & flow (client)

- **Lobby (real-money mode):** 3 tier cards showing buy-in, death stake, and live pot.
  Only interactive when `REAL_MONEY_ENABLED`; otherwise "soon" (existing behavior).
- **Wallet panel:** real $KABOOM balance; **Deposit** (treasury address + "I've sent it");
  **Withdraw** (amount → your wallet); transaction history.
- **In-game HUD:** real balance, **live pot**, **Round X/5** counter, your round-wins.
- **Game-end screen:** winner + payout (pot − rake), per-player net.

---

## Section D — Testing & gating

- **Pure logic unit tests** (no chain): 5-round game lifecycle, round-win counting,
  buy-in → locked pot, loot drop from balance, loot pickup credit, uncollected-loot sweep,
  rake, payout, tie split, broke-player drop, join-requires-buy-in+stake.
- **Custody unit tests** with a **mocked chain**: deposit credit idempotency, debit +
  rollback on send failure, min/max/daily-cap enforcement, pause switch. **Never** hit a
  real RPC in tests.
- New deps: `@solana/web3.js`, `@solana/spl-token` (only imported by `custody.js`).
- Gating: env unset → real joins blocked (as today), custody endpoints respond "disabled".
- ⚠️ **Legal review required before activation.**

---

## Components & boundaries
- `server.js` game loop — game = 5 rounds, round-win tally, pot accrual + loot sweep,
  game-end settlement (extends existing `roundAnte`/`settleDeath`/`maybeEndRound`).
- `store.js` — `"real"` balance + ledger/audit (extends existing currency support).
- `custody.js` (**new**) — deposit watcher + withdraw, all chain/treasury-key code.
- `public/index.html` — wallet panel, tier cards, in-game pot/round HUD, game-end screen.
- HTTP endpoints (gated): `POST /deposit-info`, `POST /withdraw`, `GET /wallet` (balance+history).

## Open items for the plan
- Whether withdraw auto-creates the recipient ATA.
- Exact ledger storage shape in `store.js` (+ Supabase mirror?).
- Deposit-watcher poll interval & confirmation depth.
- Whether game/round HUD changes also apply (cosmetically) to training.
