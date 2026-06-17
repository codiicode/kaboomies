# KABOOMIES

Online multiplayer Bomberman-style brawler with a **$KABOOM** token economy — **kaboomies.fun**

Build your *kaboomie*, join a map, and brawl. Every time you get bombed you **drop $KABOOM** that anyone can grab. Last kaboomie standing wins the round.

## Play instantly (no server)
Open `public/index.html` and hit **PLAY NOW → JOIN GAME**. With no server it runs locally vs AI bots so it's instantly playable (full token economy included). Served by the Node server below, the same button joins live online multiplayer.

## Run online
Node.js 18+.
```bash
npm install
npm start            # http://localhost:3000
```
Open in several tabs / on phones to play together.

## Maps (rooms) — three stakes tiers
Pick an arena in the character screen. Each map is its own **online room** — everyone who picks the same map plays together. The three maps differ by how much **$KABOOM you drop every time you die**:
- **Rookie Ring** — low stakes, drops **10** $KABOOM/death, 33×17
- **Brawl Arena** — mid stakes, drops **100** $KABOOM/death, 35×18 (default)
- **High Roller** — high stakes, drops **1000** $KABOOM/death, 37×19 (bigger arena, more obstacles)

Every room holds up to **10 players**; an 11th joiner spins up a fresh room of the same map automatically. 40% of each death-drop feeds the round **pot** (winner takes it); the rest scatters as grabbable coins.

Each arena has a small **central obstacle** (the leaderboard sits above it) that players move around. The board fills the screen edge-to-edge.

Offline-vs-bots fills the arena with up to 7 bots so big maps still feel busy.

## AI-generated look + procedural arenas
Every round the server rolls a fresh **seed**; the layout is regenerated and the client picks one of **12 hand-built themes** (Winter Wonderland, Stadium, Haunted Yard, Sugar Rush, Paradise Cove, Deep Space, Jungle Ruins, Dusty Dunes, Lava Forge, Frozen Lake, Neon City, Coral Reef) so no two rounds look alike. Obstacle generation has **7 layout styles** (pillar fields, scattered blocks, wall segments, room outlines, diagonal stripes, plus-clusters, chambered grids) for varied, fair (180°-symmetric) maps.

**Sudden death:** if a round runs long, the arena starts **closing in** — outer rings turn to walls and crush anyone caught, squeezing survivors toward the centre so rounds always end fast (great with a full lobby).

## Procedurally generated arenas
Every round the indestructible obstacle layout is **freshly generated and placed differently** — symmetric (fair for all spawns), always fully connected (verified by flood-fill, with a safe fallback), spawns kept clear, and the central leaderboard block preserved. No two rounds look the same.

## $KABOOM economy
- Every wallet starts with **1000 $KABOOM** (tracked server-side per wallet).
- On death you drop **100 $KABOOM** as a coin on the tile; walk over a coin to collect it.
- Balances + drops are streamed to all players and shown in the HUD and scoreboard.

## Wallet
- **Connect Wallet** uses Phantom (Solana). If Phantom isn't installed you can play as **guest**.
- The connected address is used as the player's identity/key for balances.

### On-chain status / next steps
Balances are currently authoritative **server-side (in-memory)** — this is the game economy layer, ready to be backed by real on-chain $KABOOM. Not yet wired: signing in with a wallet signature, persisting balances to a database, and settling real SPL-token transfers. Those are deliberate follow-ups (they move real funds and need a signed-auth + treasury design); the game logic and data flow are built to plug into them.

## Controls
- **Move:** WASD / arrows, or on-screen D-pad
- **Bomb:** Space, or the BOMB button

## Health (HP)
Everyone starts **every round at 100 HP**, shown as a bar above the kaboomie.
- Standing on the **bomb's tile or a tile right next to it** = **100 damage → instant death**.
- Caught **further out** in the blast = **50 damage** — so it takes **two hits** to go down out at the edges.
- Each explosion damages a given player **at most once**; HP resets to full at the start of every round.

## Levels (account progression)
A persistent **account level per wallet**, earned through play and shown as a gold **"Lv N"** badge above your kaboomie.
- **XP:** kill **+25**, round win **+100**, crate destroyed **+2**, coin pickup **+5**.
- **Curve:** advancing from level *L* to *L+1* costs `100 + (L−1)×60` XP (gentle ramp, no walls).
- **Prestige + cosmetic only** — levels give **no combat advantage**, so matches stay fair and skill decides. Stored server-side per wallet (signature-verified, cheat-resistant); offline practice tracks a local level.

## Lobby, pot, social & accounts (new)
- **Lobby** — `GET /lobby` returns every arena (with its death-drop stakes) plus live player counts + room status; the in-app lobby polls it and lets you pick a room.
- **Round pot** — 40% of every death-drop feeds a **$KABOOM pot**; the round winner takes it. Real stake feel.
- **Kill feed, emotes & sound** — live kill/win feed, tap-to-emote bubbles, and Tone.js sound effects (mute toggle, top-right).
- **Global highscore** — top $KABOOM holders shown in the lobby; served from the store.
- **Signed wallet login** — Phantom signs a login message; the server verifies the signature (tweetnacl) so a player can only claim a wallet they actually own. Balances + wins are **persisted** (JSON file by default; Supabase when configured) and are server-authoritative.

### Persistence / Supabase
By default the server saves to `data.json` (zero setup). To use Supabase set env vars and create the table:
```
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_SERVICE_KEY=...        # service role key, server-side only
```
```sql
create table players (
  wallet text primary key, name text,
  balance bigint default 1000, wins int default 0,
  updated_at timestamptz default now()
);
```

### Honest status (on-chain)
Balances are server-authoritative and persisted, and login is signature-verified — a solid, cheat-resistant foundation. Real SPL-token settlement of $KABOOM on Solana is the remaining step and is **not** wired (it moves real funds and needs a treasury + on-chain program). The data flow is built to plug into it.

## Arena themes (new)
Each round the seed picks a full **theme**, not just colours — shared by everyone in the room:
- ❄ **Winter Wonderland** — snowy floor, christmas-tree walls, wrapped-present crates, falling snow
- ⚽ **Stadium** — mowed-grass pitch, training-cone walls, football crates
- 🎃 **Haunted Yard** — dark floor, tombstone walls, jack-o-lantern crates
- 🍭 **Sugar Rush** — pink floor, chocolate-block walls, wrapped-candy crates
- 🏖 **Paradise Cove** — sand floor, palm-tree walls, beach-ball crates
- 🚀 **Deep Space** — starfield floor, asteroid walls, alien-cube crates
- plus **Classic** with the procedurally generated colour palette
In-game **music**: a procedural chiptune chase loop (pumping bass + frantic arpeggio + four-on-the-floor drums) that **speeds up during sudden death**. The 🔊 button mutes music + SFX together.

Sudden-death now starts at 50s and closes one ring every 4.2s (much slower, fairer endgame).

## Voice chat (new)
Players in the same room can talk while they play — **WebRTC peer-to-peer audio**, with the game's WebSocket used only for signalling (offer/answer/ICE relay). Tap 🎙️ (top-right, multiplayer only) to join the voice channel, then **push-to-talk**: hold **V** (desktop) or the on-screen **HOLD TO TALK** button (mobile) to speak. Mic is muted the rest of the time — clean audio in a hectic game. A green ring pulses around whoever is talking.
- **Privacy:** off by default; the browser asks for mic permission on first use.
- **Requirements:** microphone access needs **HTTPS** (or localhost). Deploy behind TLS.
- **NAT traversal:** uses free public STUN servers. ~10–20% of users behind symmetric NAT will also need a **TURN relay** (e.g. coturn, Twilio, Metered) — add its URL/credentials to `RTC_CFG.iceServers` in index.html.
- **Topology:** full mesh, ideal for small rooms. For large rooms at scale, move to an SFU (mediasoup / LiveKit).
- **Tested:** the signalling relay is verified server-side (peer discovery + offer/ICE routed only to the right peer in the right room). The actual audio path must be tested in two real browsers over HTTPS.

## Characters
Selectable bases, all drawn **procedurally** in the game's vector style: **Chillhouse**, **Hero**, **Tung Sahur** (wooden-log brawler with a bat), **The Black Bull** (horned bull mascot), **WIF** (shiba in a pink knit hat), **Popcat** (open-mouth cat, mouth pops continuously), **ALON** (silver shag, yellow/black bandana, big round shades), and **MITCH** (clown-face). Pick skin/clothes colours in the customizer.

## Loot, bounty & stakes
Crates drop one of three powerups (a bit rare, ~30%): **bomb** (+1 bomb), **🔥 fire** (bigger blast), **👟 speed**. 

**Bounty drops:** a player on a kill-streak drops a bigger $KABOOM bounty when they finally die — hunt the leader. **Stakes:** the death-drop amount is set by the map (10 / 100 / 1000), so High Roller rounds swing huge pots. Internal balances today; plugs into on-chain settlement later.

Verified by server unit tests (pierce/shield/kick/remote/bounty/wager), local-engine tests, and the live integration suite. On-chain settlement, ranked seasons, quests, cosmetic trading, theme hazards, teams and auto-clips are the deliberately-sequenced next batch.

## Login / wallet
- **Connect Wallet** detects Phantom, Solflare or Backpack. On desktop it opens the wallet's connect popup; on mobile (no injected wallet) it opens the game inside Phantom's in-app browser via a universal link instead of dumping you on the marketing site. Over file:// it tells you to host on http(s).
- **Play as Guest** — zero-friction, no wallet needed (balances are session-only and excluded from the global leaderboard).
- **Email / Social (Privy)** — built in, see *Privy setup* below.
- (Was recommended) **Privy** for email + Google/Apple/Discord/X login with an auto-created embedded wallet, so non-crypto players still get a signable, persistent identity. Needs a Privy App ID + SDK.

## Privy setup (email / social + embedded wallet)
The login glue is wired and tested; to switch it on:
1. Create an app at **dashboard.privy.io**.
2. Enable **Solana embedded wallets** and the login methods you want (email, Google, Apple, Discord, X).
3. Under the app settings, add your game's domain to **Allowed origins**.
4. Open `public/index.html`, find `const PRIVY_APP_ID = ""` and paste your App ID.
5. Serve over **HTTPS**. The "✉ Email / Social" button then appears automatically.

How it works: Privy logs the player in and auto-creates a Solana embedded wallet; the game reads that wallet's address + `signMessage`, signs the same `KABOOMIES login` message a normal wallet would, and the server's `auth.verify` accepts it unchanged — so social-login players get the same cheat-resistant, persistent identity as wallet users. The Privy SDK loads in-browser from esm.sh (no build step). Test the live login flow in a browser; ping if the SDK version needs an adapter tweak.

### Privy App Secret — keep it server-side only
Your **App ID** is in `public/index.html` (it's a public client id — fine to ship).
Your **App Secret** must NEVER go in the client or any committed file. It's only needed
if you later add *server-side* Privy token verification, in which case set it as an env var:
```
export PRIVY_APP_SECRET=...      # server only, never in frontend
```
The current login flow doesn't need it (the server verifies the wallet signature directly).
Since the secret was shared in plaintext, consider rotating it in the Privy dashboard.
