# WebSocket Rate Limiting + Input Hardening — Design Spec

Date: 2026-06-19
Status: Approved direction ("fixa rate limiting"), pending build

## Goal

Harden the authoritative WebSocket server against message floods, oversized
payloads, and malformed input — without affecting legitimate play. The server is
already authoritative (clients only send input); this adds abuse resistance.
(Reconnect is intentionally NOT built — a disconnect means you're out.)

## Threats addressed

1. **Message flood** (any type) → CPU/broadcast load. A client could send
   thousands of `in`/`bomb`/`emote`/`rtc` msgs/sec.
2. **`join` / `auth.verify` flood** → `auth.verify` is ed25519 (expensive). A
   flood of join attempts (each with a fake `auth`) is a CPU-DoS.
3. **Oversized payloads** → memory. A multi-MB message would be buffered.
4. **Malformed fields** → e.g. `name: 12345` crashes `(m.name||"Player").slice`
   (numbers have no `.slice`).

## Design (all in `server.js`)

### 1. Max payload
Create the server with a payload cap: `new WebSocketServer({ server, maxPayload: 16384 })`
(16 KB). Big enough for the largest legit message (a WebRTC SDP in an `rtc`
relay, ~2–4 KB; a `join` with a 64-byte signature, < 1 KB) but blocks
memory-bomb payloads. The `ws` lib closes a connection that exceeds `maxPayload`.

### 2. Per-connection token-bucket rate limit
Pure, testable helper:
```
// state: { tokens, last, over }. Returns true if the message is allowed.
function rateAllow(state, now, rate = 30, burst = 50) {
  state.tokens = Math.min(burst, state.tokens + (now - state.last) * rate / 1000);
  state.last = now;
  if (state.tokens >= 1) { state.tokens -= 1; state.over = 0; return true; }
  state.over = (state.over || 0) + 1;
  return false;
}
```
- Each connection gets `ws._rl = { tokens: burst, last: Date.now(), over: 0 }`.
- On each incoming message, BEFORE `JSON.parse`: if `!rateAllow(ws._rl, Date.now())`
  → if `ws._rl.over > 200` (sustained flood) `ws.close(1008, "rate")`; else just
  `return` (drop). Normal bursts (≤50) pass; sustained >30/s is shed; egregious
  floods close.
- Rate/burst chosen so real play never trips it: legit clients send `in` on input
  change + occasional bomb/det/emote — well under 30/s. Mobile d-pad + fire is
  similar. 50-burst absorbs a quick flurry.

### 3. Join throttle (protect `auth.verify`)
- **One successful join per connection:** at the top of the `join` branch, if
  `player` is already set, `return` (ignore re-joins — also fixes a latent
  player-leak where a second join orphaned the first player object in its room).
- **Cap join attempts:** `ws._joins = (ws._joins||0) + 1; if (ws._joins > 15) return;`
  at the start of the `join` branch (before `auth.verify`). 15 is plenty for
  legit ret(blocked real → switch to training, etc.) but caps verify-spam. The
  token bucket already limits join attempts to ≤30/s; this caps the lifetime
  total.

### 4. Field validation / coercion
- `name`: `String(m.name == null ? "Player" : m.name).slice(0, 14)` (never call
  `.slice` on a non-string). Keep the existing default.
- Keep existing coercions: `in` → `!!` booleans; `emote` → `String(m.e||"").slice(0,4)`.
- `skin`/`clothes`: coerce to string with the existing `|| default` (they're only
  echoed in snapshots as colors; a non-string is cosmetic, not a crash — but
  coerce defensively: `String(m.skin||"#e8b07a").slice(0,12)` etc. — keep simple).
- `rtc`: `m.to` is a Map key (safe); `m.data` is relayed as-is, size-capped by
  `maxPayload`. No change needed beyond the cap.

## Out of scope (YAGNI)
- Per-IP / connection-rate limiting (needs proxy/IP handling; Railway/edge can do
  this later). This spec is per-connection message limiting.
- Reconnect (intentionally not built).
- Distributed/multi-instance rate state (single instance today).

## Testing
- Unit-test `rateAllow`: under-rate calls return true; a burst beyond `burst`
  returns false; tokens refill over time (advance `now`); `over` increments while
  blocked and resets when allowed. (Pure function, deterministic with injected `now`.)
- Unit-test the name coercion path indirectly is hard (inside the WS handler);
  instead unit-test a small `safeName(v)` helper if extracted, or rely on the
  integration check.
- Integration (extend the live/integration style): a client that floods messages
  gets throttled/closed but a normal client is unaffected; a `join` with
  `name: 12345` does not crash the server (server stays up, other clients keep
  getting snapshots).
- Manual: normal play in preview is unaffected (no dropped inputs at human rates).
