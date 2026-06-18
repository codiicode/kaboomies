# Bots to Fill Empty Rooms — Design Spec

Date: 2026-06-18
Status: Approved decisions, pending spec review

## Goal

A solo player should never sit at "Waiting for players…". Fill training rooms
with server-driven AI bots so there's always action; fade bots out as real
players arrive. Bots are ephemeral practice opponents — they never touch the
persistent economy, stats, quests, unlocks, or leaderboard.

The bot AI already exists client-side (`botThink` in the offline `startLocal`
sim). This feature ports that behavior **server-side** into the authoritative
game loop.

## Locked decisions

- **Headcount:** fill to a target of **4** total players when ≥1 human is
  present. Bot count = `clamp(TARGET - humans, 0, capacity)`. Humans=1→3 bots,
  2→2, 3→1, 4+→0.
- **Fade-out:** recompute desired bots when a human joins/leaves and at each
  round start; add bots immediately on join (so a solo player's round can
  start); remove surplus bots at round boundaries (or when a bot is already
  dead) to avoid disrupting an active round.
- **Ranked gate (progression integrity):** a round counts toward persistent
  **balance, stats, quests, wins, and leaderboard ONLY if the room has ≥2 human
  players** ("ranked"). Solo-with-bots is practice: **XP is still granted**
  (level rises, so solo play is rewarding and Mitch's level-5 unlock is
  reachable), but no chips move and no stats/quests/wins/leaderboard updates.
- **Blend in:** bots use varied kaboomie names/skins and appear as normal
  players in snapshots — no "bot" tag.
- **Training only:** bots are added only to play-mode rooms, never real-money.
- **Ephemeral:** bots have no persistent key/balance, never appear on the
  leaderboard, and are removed when the last human leaves (so the room still
  drops and isn't kept alive by bots).

## Bot model (`server.js`)

A bot is a player object in `room.players` shaped like a human player but:
- `id`: from the same `nextId++` sequence.
- `bot: true`, `ws: null` (a stub with `readyState !== 1` so snapshot
  broadcasts and toast sends skip it safely — guard all `p.ws.send` with
  `p.ws && p.ws.readyState === 1`, which the code already does in the snapshot
  loop; audit the others).
- `key: "bot:" + id`, `verified: false`, `voice: false`.
- `name`: from a bot-name pool (e.g. Sparky, Boomer, Dyna, Pixel, Fuse, Blanka,
  Volt — the names the offline sim already uses), de-duplicated per room.
- `base`/`skin`/`clothes`: random from the existing roster (hero/house/etc.)
  for visual variety.
- `ai: { tc, tr, flee }`: AI target-tile state (set in `resetPlayer`/spawn).

`resetPlayer` already sets combat fields; extend it (or the bot factory) to
initialize `ai`. Bots are added via the normal `addPlayer(room, bot)` so they
get a spawn slot and the round logic treats them as players.

## Lifecycle (`server.js`)

- `botName(room)` → an unused name from the pool.
- `makeBot(room)` → a bot player object (fields above), `addPlayer(room, bot)`.
- `humanCount(room)` → players where `!p.bot`.
- `syncBots(room)`:
  - if `humanCount === 0`: remove all bots (so `players.size` can reach 0 and
    `dropRoom` fires). 
  - else: `desired = clamp(TARGET_PLAYERS - humanCount, 0, MAX_PLAYERS - humanCount)`;
    add bots until `botCount === desired`; if over, remove surplus bots
    (prefer dead ones; defer removing live bots until `newRound`).
  - `TARGET_PLAYERS = 4`.
- Call `syncBots(room)` after a human `addPlayer` in the join handler, after a
  human disconnect (`ws close`), and inside `newRound(room)` (so headcount
  re-balances between rounds and surplus live bots are trimmed).
- Removing a bot: delete from `room.players`. (No persistence/cleanup needed.)
- Guard the existing empty-room drop: it must key off **humans**, not
  `players.size`. Change the close handler so the room is dropped when the last
  human leaves (after removing bots), not only when `players.size === 0`.

## Bot AI (`server.js`) — ported from client `botThink`

Add server-side helpers operating on `room` (mirror the client logic, which is
proven):
- `botDangerSet(room)`: set of `"c,r"` tiles covered by the projected blast of
  every active bomb (use the bomb's `range`/`col`/`row`, stopping at walls —
  reuse the same cell-walk as `explode`). Bots avoid these.
- `botWalkable(room, c, r)`: in-bounds, `grid[r][c] === 0` (not wall/crate), and
  no bomb on the tile.
- `botBlastCells(room, c, r, range)`: cells a bomb placed at `(c,r)` would hit.
- `botThink(room, bot)`: same decision tree as the client —
  1. if centered on its tile and in danger → flee to a safe neighbor;
  2. else if it can bomb and there's an adjacent crate or an enemy within
     `range+1` and an escape tile exists → `placeBomb(room, bot)` then flee to
     the escape tile;
  3. else wander/chase: pick a free, non-danger neighbor biased toward the
     nearest *alive* player (human or bot).
  Then set `bot.in = {l,r,u,d}` to drive toward the target tile (same math as
  client). `placeBomb`/`movePlayer` are the existing server functions.
- In `tick(room, dt)`: before the movement loop, for each `bot` that is
  `alive` and `room.phase === "playing"`, call `botThink(room, bot)`. The
  existing `movePlayer` then consumes `bot.in`.

Bots use the same movement/bomb/power-up code as humans (they can pick up
power-ups, get caught by sudden-death walls, etc.).

## Ranked gate (progression integrity)

`isRanked(room)` → `humanCount(room) >= 2`.

Apply in the economy/stat hooks already wired (Task C / earlier):
- **`settleDeath(room, victim, killer)`**: only move balances when
  `isRanked(room)`. In a non-ranked (solo+bots) room, skip the balance transfer
  entirely (practice — no chips won/lost). Always reset `victim.streak`.
- **kill hook**: `gainXp(room, killer.key, XP_KILL)` always (and only for
  non-bot killers — a bot earns no XP); `store.bumpStat(killer.key,"kills")` +
  `bumpQuest(...,"kills")` only when `isRanked` and the killer is human.
- **death hook**: `store.bumpStat(victim.key,"deaths")` only when `isRanked` and
  victim is human.
- **crate hook**: `gainXp(ownerKey, XP_CRATE)` always (human owner only);
  `bumpStat(crates)` + `bumpQuest(crates)` only when `isRanked`.
- **pickup hook**: `gainXp(XP_PICKUP)` always (human); `bumpStat(pickups)` +
  `bumpQuest(pickups)` only when `isRanked`.
- **win/round-end** (`maybeEndRound`): the pot/payout, `w.wins++`,
  `store.bumpWin`, `bumpStat(games)` for participants, and the win/games quests
  only when `isRanked`. `gainXp(XP_WIN)` to a human winner still granted
  (rewards solo practice wins with XP only). Bots never get XP/stats/wins.
- **bots never persist:** all of the above already no-op for `bot:`/missing
  keys IF `store` treats `bot:` like guests. **Add `bot:` to the guard:** update
  `store.isWalletKey` to `return !!key && !key.startsWith("guest:") &&
  !key.startsWith("bot:")`. Also ensure `gainXp`/`bal`/`setBal` are never called
  for bots (guard with `!player.bot`), so no `bot:` rows are written anywhere.

Net effect: solo + bots → only the human's XP/level moves; ranked (≥2 humans) →
full economy/stats/quests/wins as today. (Minor accepted caveat: two humans in a
room with bots can still progress while bots are present — acceptable for v1.)

## Client (`public/index.html`)

Mostly unchanged — bots arrive in the normal snapshot `players` array and render
like anyone else (blend in). The "Waiting for players…" banner already keys off
player count, which now includes bots, so it disappears once bots fill in.
- No bot tag in the UI.
- Optional (nice-to-have, can skip): suppress the join-time streak/quest toasts'
  expectations in non-ranked rooms — but since the server simply doesn't send
  stat/quest changes in solo rooms, the client needs no change.

## Edge cases

- **Round can't start with <2 players:** `maybeEndRound`/round-start already
  needs ≥2; bots guarantee this once a human is present.
- **All bots + 0 humans:** can't happen — bots are removed when the last human
  leaves; the room then drops.
- **Bot in real-money room:** never added (only play-mode rooms call syncBots).
- **Snapshot/toast sends to bots:** guarded by `p.ws && p.ws.readyState === 1`.
- **Sudden death / kicked bombs / power-ups:** bots use the same code paths;
  no special handling.
- **Leaderboard:** `topScores` already filters `guest:`; bot keys never get a
  balance row (guarded), so they can't appear.

## Testing

- Unit-test the pure helpers: `botWalkable`, `botBlastCells`, `botDangerSet`
  (construct a small room/grid + a bomb, assert the danger tiles), and
  `isRanked`/`humanCount`.
- Unit/integration: `syncBots` headcount math (humans 0/1/2/4 → bots
  4-cap/3/2/0; humans→0 removes all); `settleDeath` skips balance moves in a
  non-ranked room and moves them in a ranked room; bot keys never persist
  (`store.isWalletKey("bot:1") === false`).
- Behavioral (integration, like the existing test.js): one human joins an empty
  brawl room → bots fill to 4 → a round starts and progresses → snapshot shows
  4 players. Keep it short.
- Manual preview: join solo → see bots fill and play; confirm no balance/stat
  change solo (XP only); confirm the offline `startLocal` path is unaffected.

## Out of scope (YAGNI)
- Difficulty tiers / adjustable bot skill (use the existing AI as-is).
- Bots in real-money rooms.
- Per-interaction anti-farm beyond the ≥2-human ranked gate.
- Pathfinding beyond the existing greedy neighbor heuristic.
