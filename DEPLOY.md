# Deploying KABOOMIES to kaboomies.fun

KABOOMIES is a **stateful Node.js + WebSocket** server that also serves the game
client. It must run on a host that keeps a long-lived process with open
WebSocket connections — **not** a serverless platform (Vercel/Netlify will not
work). Recommended host: **Railway** (easiest). Fly.io works too.

The whole thing is one service: `npm start` runs `server.js`, which serves
`public/index.html` and handles the live game over WebSocket.

---

## 1. Put the code on GitHub

```bash
git init
git add .
git commit -m "KABOOMIES v1"
git branch -M main
git remote add origin https://github.com/<you>/kaboomies.git
git push -u origin main
```

(`node_modules`, `data.json` and `kaboomies.json` are git-ignored.)

## 2. Create the Railway service

1. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
2. Railway auto-detects Node, installs deps, and runs `npm start`.
   - It sets `PORT` automatically — the server already reads `process.env.PORT`,
     so don't hardcode a port.
3. Wait for the build, then **Settings → Networking → Generate Domain**.
   You get a `https://<name>.up.railway.app` URL — open it and confirm the game
   loads and you can play a round. This is your staging URL.

## 3. Make balances + XP survive restarts (Volume)

The default filesystem is wiped on every deploy. Add a persistent volume so the
$KABOOM economy and account levels are durable:

1. In the service: **New → Volume**, attach it to the service.
2. Set the **mount path** to `/data` (any path is fine).
3. That's it — the server auto-detects the mounted volume and writes its save
   file there (`RAILWAY_VOLUME_MOUNT_PATH`). No env var needed.
   - (If you prefer to be explicit, set `KABOOM_DATA=/data/kaboomies.json`.)

Notes: volumes require a paid plan (Hobby ~$5/mo). A volume pins the service to a
**single instance** and adds a few seconds of downtime on redeploy — totally
fine for launch scale.

## 4. Point kaboomies.fun at Railway

1. Service → **Settings → Networking → Custom Domain → add `kaboomies.fun`**
   (and `www.kaboomies.fun` if you want it).
2. Railway shows **two DNS records**: a **CNAME** (routes traffic) and a **TXT**
   (verifies ownership). Add **both** at your domain registrar exactly as shown.
   - Apex (`kaboomies.fun`) needs a provider that supports CNAME-flattening /
     ALIAS (Cloudflare, Namecheap, etc.). If yours doesn't, put the game on
     `www` or `play.kaboomies.fun` and redirect the apex.
3. Wait for verification + automatic TLS (usually minutes, up to a few hours).
   Track with dnschecker.org.

## 5. Turn wallet login back on for the live domain

The client uses Privy for wallet login. Add the production origin so it works:

- Privy dashboard → your app → **allowed origins / domains** → add
  `https://kaboomies.fun` (and `www`, and the `*.up.railway.app` URL if you want
  to test there too).
- Until you do this, **guest play still works** — only wallet login is blocked.

## 6. Go-live checklist

- [ ] Game loads at `https://kaboomies.fun`
- [ ] Two browsers/phones can join the same map and play together
- [ ] Voice chat works (needs HTTPS — it does on Railway)
- [ ] Connect Wallet succeeds (Privy origin added)
- [ ] Balance/level persists after a manual redeploy (volume working)

---

## Alternative: Fly.io

Fly also supports persistent WebSocket + volumes. Install `flyctl`, run
`fly launch` (generates a Dockerfile + `fly.toml`), `fly volumes create data`,
mount it, set `KABOOM_DATA=/data/kaboomies.json`, `fly deploy`, then
`fly certs add kaboomies.fun` and add the shown DNS records.

## Two game modes: Training vs Real money

The game ships with two modes, chosen in the lobby:

- **Training (free):** play-money chips. Everyone starts with a free balance,
  nothing is withdrawable. Fully working today — this is what players use now.
- **Real money ($KABOOM):** a *separate* balance that only grows from real
  deposits and is withdrawable. **Off by default**, shown as "soon" in the lobby
  until the custody layer is wired. Free chips can never be withdrawn as real
  tokens — they are different balances and different rooms.

### Turning real money on (only after the token + custody exist)

Real mode activates only when all three env vars are set on the service:

```
KABOOM_MINT      = <the $KABOOM SPL mint address>
TREASURY_SECRET  = <base58 secret key of the treasury wallet>   # keep secret!
SOLANA_RPC       = <an RPC endpoint, e.g. a Helius URL>
```

Until then the server refuses real-money joins (`blocked: real_soon`) and the
lobby shows real mode as "soon". Required sequence:

1. **Create the $KABOOM SPL token** (e.g. via pump.fun) → you get a mint address.
2. **Create a treasury wallet** (its keypair) — it holds deposits and signs
   payouts. Put the secret key ONLY in `TREASURY_SECRET`, never in git.
3. **Build the custody module** (next dev step): a deposit watcher that credits
   the real balance when $KABOOM lands at the treasury, and a withdraw endpoint
   that signs treasury → player transfers. With safeguards: per-wallet daily
   caps, idempotent crediting (no double-credit per tx), manual review above a
   threshold, and only a small hot float (the rest kept cold).
4. **Test on devnet first**, then set the three env vars on mainnet to flip it on.

## Honest status (what "live" means here)

- This ships a **real, playable multiplayer game** with a server-authoritative,
  signature-verified, persisted $KABOOM economy + account levels.
- $KABOOM is currently a **server-side number, not an on-chain SPL token** — there
  is no real-money settlement wired in. Making $KABOOM a real tradeable token
  (e.g. pump.fun) with real-stakes wagering turns this into a regulated activity
  (token + gambling rules, incl. Sweden/Spelinspektionen). Get that reviewed
  before attaching real money.
- Scaling past one instance later (multiple servers) needs shared state
  (Supabase/Redis) instead of the single-process file store — a separate step.
