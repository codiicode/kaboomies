# Character Unlocks + Arena Stakes + Lobby Revamp — Design Spec

Date: 2026-06-18
Status: Approved decisions, pending spec review

## Goal

Four related changes:
1. **Character unlocks** — Hero is the only default; the other 7 characters unlock via stat milestones (verified wallets only). Guests get Hero only. The picker shows owned vs locked + progress.
2. **Arena stakes mechanic** — each training arena pays/charges a fixed stake **per kill/death**: Rookie Ring ±10, Brawl Arena ±100, High Roller ±1000 $KABOOM. This **replaces** the current death-drop/pot economy in training.
3. **Lobby revamp** — much bigger arena cards filling the space, clear stake labels, High Roller styled premium (gold/coins/$), via the frontend-design skill.
4. **FNF WARS** — a third lobby mode tab ("🔥 FNF WARS · SOON"), disabled teaser like Real money.

Reward currency is the existing free training chips ($KABOOM balance in play mode). Real-money mode stays gated/unchanged.

## Locked decisions

- Tiers by name, low→high: **Rookie Ring 10 → Brawl Arena 100 → High Roller 1000**; premium card = **High Roller**. (Matches existing `MAPS[*].deathDrop`.)
- Stakes are a **real mechanic change**: literal +X to the killer, −X from the victim, per kill/death.
- Milestones as proposed (below).
- Default character = **hero** for everyone; guests only ever have hero.

## Part 1 — Character unlocks

### Characters (`BASES` in index.html, ids)
`hero` (default), `house` (Chillhouse), `sahur` (Tung Sahur), `bull` (The Black Bull), `wif`, `popcat`, `alon`, `mitch`. All are code-drawn (`IMG_BASES` is empty) — no assets needed.

### Milestones (computed from persistent stats; verified wallets only)

| base   | name          | requirement      | stat field    |
|--------|---------------|------------------|---------------|
| hero   | Hero          | default (always) | —             |
| house  | Chillhouse    | play 3 games     | games ≥ 3     |
| popcat | Popcat        | break 100 crates | crates ≥ 100  |
| sahur  | Tung Sahur    | win 5 rounds     | wins ≥ 5      |
| alon   | ALON          | play 25 games    | games ≥ 25    |
| mitch  | MITCH         | reach Level 5    | level ≥ 5     |
| wif    | WIF           | get 100 kills    | kills ≥ 100   |
| bull   | The Black Bull| win 25 rounds    | wins ≥ 25     |

### New module `characters.js` (pure, unit-tested)
```
CHARACTER_REQS = [ {base, name, label, stat, target}, ... ]   // the 7 lockable
DEFAULT_BASE = "hero"
unlockState(s)  // s = {games,kills,wins,crates,pickups,level}
  -> [{ base, name, label, target, stat, prog, unlocked }]    // 8 entries incl hero(unlocked:true)
isUnlocked(base, s) -> bool  // hero always true; else stat>=target; unknown base -> false
```
`label` is human text e.g. "Win 5 rounds". `stat` maps to the stat field (or "level"). `prog` is the player's current value (capped display done client-side).

### Server wiring (`server.js`)
- `buildProfile` gains `characters: characters.unlockState({...stats, level})`.
- New `GET /characters` (no auth) → returns `CHARACTER_REQS` (base, name, label, target) + DEFAULT_BASE, so the guest/create screen can show requirement labels without a profile.
- **Join enforcement:** in the join handler, after determining `key`/`verified`, compute the unlock set:
  - verified: `s = {...store.getStats(key), level: store.levelFromXp(store.getXp(key))}`; if `!characters.isUnlocked(m.base, s)` → force `player.base = "hero"`.
  - guest: force `player.base = "hero"` (unless `m.base === "hero"`).
  This keeps unlocks real (no client bypass). `skin`/`clothes` (colors) stay free.

### Client (`public/index.html`)
- Default: change `playerSkin` default `base:"house"` → `base:"hero"`, and the `BASES`-fallback at load (`if(!playerSkin.base||locked) base="hero"`). On load, if the stored base is locked for this player, reset to hero.
- The character row (the `BASES.forEach` picker in `buildCustomizer`) renders each base with lock state:
  - unlocked → normal selectable button.
  - locked → `🔒` prefix, greyed (`.locked` class), not selectable; shows a tiny requirement+progress line under/within (e.g. "WIF · 100 kills (62/100)").
- Unlock data source: on entering the create screen, fetch the unlock state. Logged in → `POST /profile` (reuse the cached-auth fetch) → use `characters` array. Guest → only hero unlocked; labels from `GET /characters` (fetched once, cached). A shared `loadCharacters()` populates a module-level `charUnlock` map the customizer reads.
- Selecting a locked base is a no-op (optionally flash the requirement). Hero is always selectable.

## Part 2 — Arena stakes mechanic (`server.js`)

Replace the death-drop/pot economy with a direct per-kill/death transfer. `room.deathDrop` (10/100/1000) is the **stake**.

### New `settleDeath(room, victim, killer)` (replaces `killDrop`)
```
stake = room.deathDrop ?? DEATH_DROP
lost  = min(stake, bal(victim.key, room.cur))
if (lost > 0) setBal(victim.key, bal - lost)          // victim loses up to `stake`
if (killer && killer.id !== victim.id && killer.alive && lost > 0)
  setBal(killer.key, bal(killer.key) + lost)          // killer gains the same amount
victim.streak = 0
```
- Called from the blast-death path (with `killer = room.players.get(f.owner)`) and the crush-death path (`killer = null` → victim just loses the stake, no recipient).
- No floor coin drops, no pot accumulation in training. `room.drops` from deaths is gone (power-up `room.ups` from crates is unchanged).
- Remove the old `killDrop` function and its calls. Bounty/`BOUNTY_*` chip bonus is removed (kill pays exactly the stake); `streak` is still tracked for the kill-feed flavor only.
- `roundAnte`/pot stays for wager rooms (gated, off); training pot stays 0 so the win payout is 0 (survival reward is the chips you already earned from kills). The win event simply reports no pot.

### Pickups stat/quest repurpose
Death coin-drops no longer exist, so the `pickups` stat + the "Grab 6 power-ups" daily quest must move to **actual power-up pickups**. Relocate `store.bumpStat(pl.key,"pickups")` + `bumpQuest(room, pl, "pickups")` from the (now-removed) coin-drop pickup site to the power-up pickup site (where a player walks onto a `room.ups` tile and gains an ability). This also fixes the pre-existing label mismatch (the quest says "power-ups").

### Stake exposure to the client
- `init` payload already sends `drop: room.deathDrop`. Add the per-kill/death framing in the UI (arena card + optionally a small in-game HUD tag "±100 / KILL"). No new server field needed beyond what `drop`/`/lobby` already provide (`/lobby` returns `drop` per map).

## Part 3 — Lobby revamp (`public/index.html`, frontend-design skill)

- **Bigger cards:** widen the grid (e.g. `minmax(280px,1fr)`, larger padding/type) so the three arenas fill the row; center the block.
- **Stake label per card:** prominent "±10 / ±100 / ±1000 $KABOOM · per kill/death", ordered low→high. Reuse the existing 🪙 coin glyph.
- **Premium High Roller:** styled distinctly (gold border/shadow, coin + `$` motifs, subtle shimmer) using the frontend-design skill for a polished, on-brand premium look — without breaking the brutalist style of the other cards.
- **Order:** Rookie Ring → Brawl Arena → High Roller (low→high). The lobby sort must place them in this stake order.

## Part 4 — FNF WARS tab

- Add a third `.mode-btn` `#mode-fnf` "🔥 FNF WARS · SOON" next to Training and Real money, styled `.soon` (disabled/greyed like real-money-soon). Clicking shows a note ("Friday Night Fights — coming soon") and does not change mode. No arenas under it yet.

## Out of scope (YAGNI)
- No new characters/skins beyond the existing 8. No cosmetic shop. No real-money changes. No FNF arenas/logic (teaser only). The offline local-sim fallback (`startLocal`, used only when no server) keeps its existing simple economy — the stake mechanic is server-authoritative for real multiplayer.

## Backward compatibility
- New stat-derived unlocks need no migration (missing stats read 0 → only hero unlocked, which is the intended default). Returning users whose stored `playerSkin.base` is now locked are reset to hero on load. Existing balances are untouched; the economy change only affects how chips move during a round going forward.

## Testing
- Unit-test `characters.js`: `unlockState` thresholds (each milestone boundary), hero always unlocked, unknown base not unlocked, `isUnlocked` guards.
- Unit/integration: `settleDeath` transfers exactly `stake` (capped at victim balance), credits killer only on a real PvP kill, burns on self/crush; `GET /characters` shape; join enforcement forces hero for a locked/guest pick (extend the existing forged-signature integration test).
- Manual preview: create screen shows hero unlocked + others locked with progress (guest = only hero); lobby shows 3 big cards with stake labels + premium High Roller + FNF tab; a kill moves chips by the stake.
