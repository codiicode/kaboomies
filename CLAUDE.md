# KABOOMIES

Real-time multiplayer Bomberman-style arena game (kaboomies.fun). A single
**stateful Node.js + WebSocket** service serves the game client and runs the
server-authoritative game loop. It must run on a host with a long-lived process
and open WebSocket connections — **not** serverless (Vercel/Netlify won't work).

## Stack

- **Server:** Node.js (>=18), `ws` for WebSocket, plain `http` for serving the
  client. Entry point `server.js`.
- **Client:** a single static `public/index.html` (vanilla JS + Canvas, no build
  step). Wallet login via Privy; voice chat over WebRTC (needs HTTPS).
- **Auth:** Solana wallet signature login — `auth.js` verifies an ed25519
  signature with `tweetnacl` + `bs58`. Signatures are valid for 5 minutes
  (`MAX_AGE_MS`). The client caches its signature (`_authCache` in `signLogin`)
  so the player isn't prompted to sign on every join.
- **Persistence:** `store.js` — a local JSON file by default
  (`data.json`, or `$KABOOM_DATA` / Railway volume mount). Optionally mirrors
  balances/wins to Supabase if `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are set.
- **No frontend framework, no bundler, no DB required to run.**

## Commands

```bash
npm install      # install deps (bs58, tweetnacl, ws)
npm start        # node server.js — serves client + runs the game (reads $PORT)
```

There is currently no test script wired in `package.json`, though core game
logic in `server.js` is exported so it can be unit-tested.

## Architecture notes

- The server is **server-authoritative**: it owns the grid, bombs, fires,
  power-ups, HP and balances; the client only sends input and renders snapshots.
- Each **map is its own room** (`MAPS` in `server.js`). Players join a room,
  rounds restart in place. State snapshots are broadcast on an interval.
- `data.json` / `kaboomies.json` and `node_modules` are git-ignored.

## HP / level system

- **HP (per round, combat):** everyone spawns each round at `MAX_HP = 100`.
  Blast damage is `DMG_CORE = 100` (bomb tile + adjacent = instant kill) and
  `DMG_EDGE = 50` further out along the arm (two hits to kill). Shields grant
  i-frames (`INVULN_MS`). HP resets every round and is **not** persistent.
- **Account level (persistent prestige, no combat power):** earned via XP in
  `store.js`. XP rewards: `XP_KILL = 25`, `XP_WIN = 100`, `XP_CRATE = 2`,
  `XP_PICKUP = 5`. Cost to go from level L to L+1 is `100 + (L-1)*60` (gentle
  linear ramp). `levelFromXp` / `levelProgress` compute level + progress.
  Levels are cosmetic/prestige only — they never affect combat stats.

## Two game modes

Chosen in the lobby:

- **Training (free):** play-money chips. Everyone starts with a free balance
  (`START_BAL = 1000`), nothing is withdrawable. Fully working today.
- **Real money ($KABOOM):** a **separate** balance that only grows from real
  deposits and is withdrawable. Free chips and real tokens are different
  balances in different rooms — free chips can never become real tokens.

### Gated real-money

Real mode is **off by default** and shown as "soon" in the lobby. It only
activates when all three env vars are set on the service:

```
KABOOM_MINT       = <the $KABOOM SPL mint address>
TREASURY_SECRET   = <base58 secret key of the treasury wallet>   # keep secret!
SOLANA_RPC        = <an RPC endpoint, e.g. a Helius URL>
```

Until then the server refuses real-money joins with `blocked: real_soon`, and
real joins always require a **verified wallet** (never guests). The custody
module (deposit watcher + withdraw endpoint with safeguards) is a future dev
step. Note: making $KABOOM a real tradeable token with real-stakes wagering is a
regulated activity (token + gambling rules, incl. Sweden/Spelinspektionen) and
must be reviewed before attaching real money.

## Deploy (Railway)

See [DEPLOY.md](DEPLOY.md) for the full guide. Summary:

1. Push to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**. It auto-detects Node,
   installs deps, runs `npm start`, and sets `PORT` automatically.
3. Add a **Volume** mounted at `/data` so balances + XP survive redeploys (the
   server auto-detects `RAILWAY_VOLUME_MOUNT_PATH`).
4. Add the custom domain `kaboomies.fun` (CNAME + TXT records) and wait for TLS.
5. Add the production origin in the Privy dashboard so wallet login works.

Fly.io is a supported alternative (persistent WebSocket + volumes).
