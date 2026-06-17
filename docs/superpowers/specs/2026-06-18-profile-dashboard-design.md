# Profile Dashboard + Daily Quests + Login Streak — Design Spec

Date: 2026-06-18
Status: Approved (design), pending implementation plan

## Goal

Give KABOOMIES a **profile dashboard** — a new screen where a logged-in player
sees lifetime stats, daily quests, login streak, and account level. It is the
home for player progression/identity. Reward currency is **XP only** (account
level is prestige, no combat power), so nothing here touches the gated $KABOOM
real-money economy.

## Decisions (locked)

- **Who:** verified wallets only. Guests see a "log in to see your profile /
  earn XP" teaser. Guest keys (`guest:<id>`) are ephemeral per connection, so
  they get no persistent profile, quests, or streak.
- **Rewards:** XP only (no chips, no $KABOOM). Granted via the existing
  `addXp`/`gainXp` path so level-ups still fire.
- **Reward delivery:** automatic on completion (no manual claim), with an
  in-game toast.
- **Scope v1:** profile dashboard + daily quests + login streak, as ONE feature.
- **Stats shown:** matches played, wins, win-rate; kills, deaths, K/D; level/XP
  progress, longest streak, crates broken, power-ups grabbed.
- **Out of scope (YAGNI):** chips won/lost net stats, guest profiles, manual
  claim, achievements wall, history graphs, per-map breakdown, real-$KABOOM
  stats (until custody exists).

## Data model (`store.js`)

New persistent per-wallet-key fields (XP already exists in `mem.xp`). All default
to 0 / empty for existing save files (backward compatible — read missing as 0).

```
mem.stats[key]  = { games, kills, deaths, crates, pickups }   // lifetime counters
mem.streak[key] = { count, best, day }                        // day = UTC day index of last grant
mem.quests[key] = { day, prog: {questId:n}, done: {questId:true} } // day = UTC day index
```

Helpers to add:
- `bumpStat(key, field, n=1)` — increment a lifetime counter, `saveSoon()`.
- `getStats(key)` — returns the counters object with 0 defaults.
- Streak + quest accessors (see below).

Persistence stays best-effort JSON (+ optional Supabase mirror, unchanged). Only
wallet keys are written (guard: `!key.startsWith("guest:")`).

## Time basis

`dayIndex() = Math.floor(Date.now() / 86400000)` — contiguous UTC day number.
Used for both quest-day equality and streak math (contiguous, unlike the
`YYYYMMDD` `dailySeed()` already used for the daily map). Quests/streak are
independent of the daily map.

## Daily quests

Pool (each maps to an event already counted in `server.js`):

| id      | label              | target | xp  |
|---------|--------------------|--------|-----|
| win     | Win a round        | 1      | 150 |
| kills   | Get 5 kills        | 5      | 100 |
| crates  | Break 25 crates    | 25     | 75  |
| pickups | Grab 6 power-ups   | 6      | 75  |
| games   | Play 4 rounds      | 4      | 75  |

**Selection:** `todaysQuests()` derives the same 3 quests for everyone from
`dayIndex()`. Use a deterministic seeded shuffle (small LCG seeded by
`dayIndex()`) over the pool, take the first 3. Pure function of the day → no per
-player storage of definitions, only `prog`/`done`.

**Progress:** bumped in the existing hooks (verified players only). When
`prog[id] >= target` and not already `done[id]`:
1. mark `done[id] = true`,
2. grant `xp` via `gainXp(room, key, xp)` (so level-ups still fire),
3. send a personal toast `{t:"toast", kind:"quest", label, xp}` to that player's
   socket (not a room-wide event — avoids spamming others).

**Reset:** on any access, if `quests[key].day !== dayIndex()` → reset
`prog={}, done={}, day=dayIndex()`.

## Login streak

Stored as `{count, best, day}`. Granted once per day on a **verified** WS join:

```
today = dayIndex()
if streak.day === today:        // already counted today → no grant
else:
  if streak.day === today - 1:  count++       // consecutive day
  else:                         count = 1      // streak broken / first ever
  streak.day = today
  best = max(best, count)
  xpAwarded = min(50 + (count-1)*25, 200)
  gainXp(room, key, xpAwarded)
```

Result (`{count, xpAwarded}`) is returned in the `init` payload so the client can
toast it.

## Server hooks (`server.js`)

All guarded to verified/wallet keys. Existing line references:

- **kill** (~line 518): on a real kill → `bumpStat(killer.key,"kills")`; on the
  victim's death (any cause — bomb/self/crush, where `pl.alive` is set false) →
  `bumpStat(pl.key,"deaths")`. Also bump quest `kills` for the killer.
- **crate** (~line 425): `bumpStat(ownerKey,"crates")` + quest `crates`.
- **pickup** (~line 386): `bumpStat(pl.key,"pickups")` + quest `pickups`.
- **win** (~line 559): wins already via `store.bumpWin`; bump quest `win`.
- **round played** (new hook): when a round resolves (round-over), `games++` for
  each player who was in that round, and is the right place to mark participation.
  Implementation: increment for players present in `room.players` at resolution.

A small server-side `quests.js` module (or a section in `server.js`) holds the
pool, `todaysQuests()`, the seeded shuffle, and a `questBump(room, player, id, n)`
that updates progress + fires the grant/toast. Keep game logic exports testable.

## Transport

- **`POST /profile`** body `{wallet, auth:{ts,sig}}`. Server reads the POST body
  (accumulate chunks → `JSON.parse`), verifies with `auth.verify(wallet, ts, sig)`
  (same 5-min window as WS login). On success returns:
  ```
  { name, wallet, level, xp:{into,need,level},
    stats:{ games, wins, winRate, kills, deaths, kd, crates, pickups },
    streak:{ count, best },
    quests:[ { id, label, target, prog, done, xp } ] }
  ```
  On failure (bad/expired sig) → 401. Used by the lobby to render the profile
  screen before any WS connection exists.
- **`init`** (WS join) gains `quests` (today's defs + this player's progress) and
  `streak` (`{count, xpAwarded}`), for live in-game toasts + HUD.
- **`{t:"toast", kind, label, xp}`** — new personal WS message for quest/streak
  completion during play.

## Client UI (`public/index.html`)

- **New `screen-profile`** reached via a `👤 PROFIL` button added to the lobby.
  - Logged in → fetch `POST /profile` (using the cached `signLogin()` auth) and
    render; back button returns to lobby.
  - Guest → teaser prompting login (route to the create/login screen).
  - Layout: character avatar (reuse `drawHero`/preview canvas) + name + short
    wallet + level bar at top; a grid of stat tiles (matches/wins/win-rate,
    kills/deaths/K/D, longest streak/crates/pickups); a daily-quests list with
    progress bars + XP; a streak row (`🔥 Day N`). Mobile: single column, matches
    the existing brutalist/pixel style and is landscape/portrait friendly.
- **In-game toasts:** handle `{t:"toast"}` in the WS `onmessage` and push to the
  existing killfeed-style feed (reuse `pushFeed`); handle the `init.streak`/
  `init.quests` for a join-time streak toast.

## Edge cases

- Existing save files lack the new fields → all read as 0 / fresh (no migration).
- Day rollover mid-session: quests/streak keyed by `dayIndex()`; next access after
  UTC midnight resets quests and the streak counts the new day on next join.
- Expired cached signature: `/profile` returns 401; client re-signs via
  `signLogin()` (cache refreshes) and retries once.
- A player without a verified wallet never accrues stats/quests/streak.
- Double-grant protection: `done[id]` gates quest XP; `streak.day===today` gates
  streak XP.

## Testing

- Unit-test the pure pieces: `todaysQuests(dayIndex)` determinism + size 3;
  seeded shuffle stability; streak transition (consecutive / broken / same-day);
  quest completion → done + xp once. Game logic stays exported for tests.
- Manual: preview server, verified login, play a round, confirm stats increment,
  a quest completes with a toast + XP, streak grants on first join of the day,
  profile screen renders on mobile (portrait + landscape).
