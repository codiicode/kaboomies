# Spectator Mode — Design Spec

Date: 2026-06-19
Status: Approved decisions, pending build

## Goal

Let anyone watch a live arena without playing: a "WATCH" button on each lobby
arena card opens a read-only view of an ongoing game. Spectators receive the
same snapshots players do, but are not part of the game — they don't spawn,
don't send input, and don't affect the player cap, ranked status, economy, or
leaderboard.

## Locked decisions (lean v1)
- **Entry:** a "👁 WATCH" button on each arena card only (no full-room fallback).
- **No jump-in:** the spectator view only offers "leave / back to lobby" (no
  spectator→player conversion).
- **No shareable watch link** in v1.

## Server (`server.js`)

- **`room.spectators = new Set()`** — created in `makeRoom`; holds spectator
  `ws` connections (not player objects).
- **`{t:"spectate", map, mode}` message** — handled at the top level (alongside
  `join`, BEFORE the `!player||!room` guard):
  - Resolve `mapId`/`mode` like join. Find an EXISTING room for that map+mode
    (from `roomsByKey`) — any room has ≥1 human (bots are removed when the last
    human leaves), so any existing room is a live game. Pick the first (or the
    fullest). If none exists → `ws.send({t:"nospec"})` and return.
  - Add `ws` to `room.spectators`. Mark the connection `spectating = true` and
    remember `specRoom = room` (closure vars in the connection handler).
  - Send an init-like payload: `{t:"init", spectator:true, map, mode, COLS, ROWS,
    TILE, W, H, fuse:FUSE, grid:room.grid, seed:room.seed}` (no `id`/`bal`/wager
    — it's read-only). The client renders from this + subsequent snapshots.
- **Snapshot delivery:** in the snapshot loop, after sending `str` to players,
  also send `str` to each `ws` in `room.spectators` (guard `ws.readyState===1`;
  drop closed ones from the set).
- **Round message:** route the round-restart message through `broadcast(room,…)`
  and extend `broadcast` to ALSO send to `room.spectators` (so spectators get the
  new grid/seed on each round). Keep the bot/closed-socket guards.
- **Cleanup:**
  - On `ws close`: if `spectating`, remove `ws` from `specRoom.spectators`.
  - On room drop (last human leaves, `humanCount===0`): send `{t:"ended"}` to all
    `room.spectators`, clear the set, THEN `dropRoom`. (Spectators never keep a
    room alive.)
- **Gameplay messages from spectators:** a spectator has no `player`, so the
  existing `else if (!player || !room) return;` already drops any `in`/`bomb`/
  `det` they might send. (Spectate handling must be added before that guard.)
- Spectators are excluded from `humanCount`/cap/ranked/economy by construction
  (they're never in `room.players`).

## Client (`public/index.html`)

- **Watch button:** in `renderArenas`, add a small `👁 WATCH` button to each
  arena card, shown only when `m.players > 0` (there's a live room). Its click
  calls `spectate(m.id)` and must NOT trigger the card's `joinMap` (stop
  propagation / separate element).
- **`let spectating = false;`** module flag.
- **`spectate(id)`:** set `selMap=id`, `spectating=true`, `initAudio()`, then
  `connect()`. In the ws `onopen`, send `{t:"spectate", map:selMap, mode:selMode}`
  when `spectating`, else the normal join. (Branch the existing onopen.)
- **`init` handling:** if `m.spectator`, enter spectator mode — apply
  COLS/ROWS/TILE/W/H/grid/seed/theme like a normal init, `CV.width/height`,
  `connected=true`, `showScreen("game")`, but:
  - set a render/`spectating` flag, do NOT show the touch controls, hide the
    emote bar / PTT / mic button, and show a **"👁 SPECTATING"** banner with a
    **"‹ LEAVE"** button that closes the ws and returns to the lobby.
  - hide player-only HUD bits (balance/abilities) or neutralize them; keep the
    arena name, the scoreboard, and the killfeed (fun to watch).
- **Suppress input:** `sendInput()`, `bomb()`, `detonate()` early-return when
  `spectating`; don't attach the player input as active (the render loop still
  draws snapshots — that's all a spectator needs).
- **Messages:** handle `{t:"ended"}` ("Match ended — back to the lobby.") and
  `{t:"nospec"}` ("No live game on this arena yet.") → show a brief note, set
  `spectating=false`, close the ws, `showScreen("lobby")`.
- **Leave:** the LEAVE button + back nav set `spectating=false`, close the ws,
  return to lobby. Ensure `spectating` is reset on any exit so a later real join
  isn't treated as spectating.

## Edge cases
- Spectating an arena with no live room → `nospec` note, stay in lobby.
- The watched room ends (all players leave) → `ended` → lobby.
- A spectator's connection counts against the per-connection rate limit (fine;
  spectators send almost nothing).
- Spectators see bots too (they're normal players in snapshots) — expected.
- The offline `startLocal` path is unaffected (spectate only works against a real server).

## Testing
- Integration (like bots-live): player A joins brawl (→ a live room); a second
  connection B sends `{t:"spectate", map:"brawl"}` and receives an `init` with
  `spectator:true` plus ongoing `s` snapshots; B is NOT in the snapshot player
  list (player count unaffected by B); when A leaves, B receives `{t:"ended"}`.
- Integration: `spectate` on a map with no room → `{t:"nospec"}`.
- Manual preview: lobby WATCH button opens the spectator view (no controls,
  SPECTATING banner), renders the live game; LEAVE returns to lobby; normal play
  is unaffected.

## Out of scope (YAGNI)
- Spectator→player jump-in, shareable watch links, spectator chat, picking a
  specific room when multiple exist (just pick one), spectator count display.
