"use strict";
// Real-money custody for $KABOOM. INERT unless all three env vars are set.
// All chain/treasury-key code is lazy-loaded so tests + the gated-off server never touch Solana libs.
//
// DECIMALS: the in-game economy (balances, buy-ins, pot) is denominated in WHOLE $KABOOM.
// On-chain the token has decimals (pump.fun = 6), so 1 whole token = 10^decimals base units.
// We convert ONLY at the two chain boundaries: deposits (base units -> whole, floor) and
// withdrawals (whole -> base units). Everything else stays in whole tokens.
const KABOOM_DECIMALS = Number(process.env.KABOOM_DECIMALS || 6); // pump.fun mints use 6
const UNIT = Math.pow(10, KABOOM_DECIMALS);                       // base units per whole $KABOOM
function enabled() {
  return !!(process.env.KABOOM_MINT && process.env.TREASURY_SECRET && process.env.SOLANA_RPC);
}
function config() {
  return {
    MIN_WITHDRAW: Number(process.env.KABOOM_MIN_WITHDRAW || 500),
    MAX_PER_TX:   Number(process.env.KABOOM_MAX_PER_TX || 250000),
    DAILY_CAP:    Number(process.env.KABOOM_DAILY_CAP || 500000),
    COOLDOWN_MS:  Number(process.env.KABOOM_WITHDRAW_COOLDOWN_MS || 15000),
    PAUSED:       process.env.KABOOM_CUSTODY_PAUSED === "1",
  };
}
// Credit a confirmed on-chain deposit to the sender's REAL balance, exactly once
// per signature. Idempotent: a replay of the same sig is a no-op (returns false).
function creditDeposit({ sig, fromWallet, amount }, store) {
  if (!sig || !fromWallet || !Number.isSafeInteger(amount) || amount <= 0) return false; // amount = base units
  if (store.seenSig(sig)) return false;            // idempotent: already credited (atomic check-and-mark)
  const tokens = Math.floor(amount / UNIT);        // base units -> whole $KABOOM (sub-1-token dust floored)
  if (tokens <= 0) return false;                   // less than 1 whole token: nothing to credit
  const cur = "real";
  store.setBalance(fromWallet, store.getBalance(fromWallet, 0, cur) + tokens, null, cur);
  store.ledger(fromWallet, tokens, "deposit", cur);
  return true;
}

// ---- deposit transfer parser ----
// Given a parsed Solana transaction (the shape getParsedTransaction returns),
// derive {sig, fromWallet, amount} for an inbound SPL transfer of `mint` into
// `treasuryAta`; return null if it's not a matching inbound transfer.
//
// We reason over token-balance deltas (meta.pre/postTokenBalances), which is the
// reliable way to read transfer effects regardless of instruction encoding:
//   - the destination is the token account whose pubkey == treasuryAta, for the
//     given mint, whose amount INCREASED -> the credited amount is that delta.
//   - the sender wallet is the OWNER of the source token account for the same
//     mint whose amount DECREASED.
// accountKeys maps accountIndex -> the token-account pubkey on chain.
function parseIncoming(tx, { treasuryAta, mint }) {
  if (!tx || !treasuryAta || !mint) return null;
  const meta = tx.meta || {};
  const sig = (tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0]) || null;
  if (!sig) return null;
  const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const acct = (i) => {
    const k = keys[i];
    if (k == null) return null;
    // getParsedTransaction returns accountKeys as { pubkey: PublicKey, ... } where pubkey is a
    // PublicKey OBJECT — must coerce to a base58 string or every === comparison silently fails.
    const pk = typeof k === "string" ? k : (k.pubkey != null ? k.pubkey : k);
    return pk == null ? null : (typeof pk === "string" ? pk : (pk.toBase58 ? pk.toBase58() : String(pk)));
  };
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const amtOf = (e) => {
    const a = e && e.uiTokenAmount && e.uiTokenAmount.amount;
    const n = Number(a);
    return Number.isFinite(n) ? n : 0;
  };
  // Build pre-amount lookup per accountIndex (defaults to 0 when newly created).
  const preByIdx = {};
  for (const e of pre) preByIdx[e.accountIndex] = amtOf(e);

  // Destination: the treasury ATA token account for `mint` whose balance rose.
  let amount = 0;
  for (const e of post) {
    if (e.mint !== mint) continue;
    if (acct(e.accountIndex) !== treasuryAta) continue;
    const delta = amtOf(e) - (preByIdx[e.accountIndex] || 0);
    if (delta > 0) { amount = delta; break; }
  }
  if (!(amount > 0)) return null;

  // Sender: owner of the source token account for `mint` whose balance fell.
  let fromWallet = null;
  for (const e of post) {
    if (e.mint !== mint) continue;
    if (acct(e.accountIndex) === treasuryAta) continue;
    const delta = amtOf(e) - (preByIdx[e.accountIndex] || 0);
    if (delta < 0) { fromWallet = e.owner || null; break; }
  }
  // Fallback: a source account fully drained may only appear in pre.
  if (!fromWallet) {
    for (const e of pre) {
      if (e.mint !== mint) continue;
      if (acct(e.accountIndex) === treasuryAta) continue;
      const stillThere = post.find(p => p.accountIndex === e.accountIndex);
      const postAmt = stillThere ? amtOf(stillThere) : 0;
      if (amtOf(e) - postAmt > 0) { fromWallet = e.owner || null; break; }
    }
  }
  if (!fromWallet) return null;
  return { sig, fromWallet, amount };
}

// Test helper: build the minimal parsed-tx shape parseIncoming reads, without RPC.
// Models a transfer of `amount` of `mint` from `from`'s token account into the
// treasury ATA (`to`), as pre/post token-balance deltas.
function _fakeTx({ sig, from, to, mint, amount }) {
  const SRC = 0, DST = 1; // account indices into accountKeys
  const srcAddr = "ATA_OF_" + from;
  return {
    transaction: {
      signatures: [sig],
      message: { accountKeys: [srcAddr, to] },
    },
    meta: {
      preTokenBalances: [
        { accountIndex: SRC, mint, owner: from, uiTokenAmount: { amount: String(amount) } },
        { accountIndex: DST, mint, owner: "TREASURY_OWNER", uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: SRC, mint, owner: from, uiTokenAmount: { amount: "0" } },
        { accountIndex: DST, mint, owner: "TREASURY_OWNER", uiTokenAmount: { amount: String(amount) } },
      ],
    },
  };
}

// ---- deposit watcher (gated; never runs or loads @solana in tests / when disabled) ----
// Polls the treasury ATA for new signatures, fetches each parsed tx, and routes
// inbound $KABOOM transfers through parseIncoming -> creditDeposit. Real code,
// just guard-railed: it returns immediately unless all three env vars are set.
function startWatcher(store) {
  if (!enabled()) return; // INERT unless KABOOM_MINT + TREASURY_SECRET + SOLANA_RPC
  const web3 = require("@solana/web3.js");
  const splToken = require("@solana/spl-token");
  const bs58 = require("bs58").default || require("bs58"); // bs58@6 is ESM -> .decode lives on .default

  const conn = new web3.Connection(process.env.SOLANA_RPC, "confirmed");
  const mint = process.env.KABOOM_MINT;
  const mintPk = new web3.PublicKey(mint);
  const treasuryKp = web3.Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_SECRET));

  let treasuryAtaPk = null;
  let treasuryAta = null;
  const POLL_MS = Number(process.env.KABOOM_WATCH_MS || 10000);

  async function tick() {
    try {
      if (!treasuryAtaPk) {
        treasuryAtaPk = await splToken.getAssociatedTokenAddress(mintPk, treasuryKp.publicKey);
        treasuryAta = treasuryAtaPk.toBase58();
      }
      const sigs = await conn.getSignaturesForAddress(treasuryAtaPk, { limit: 25 });
      // oldest-first so credits land in chronological order
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        const out = parseIncoming(tx, { treasuryAta, mint });
        if (out) creditDeposit(out, store); // creditDeposit owns the seenSig idempotency gate
      }
    } catch (e) { /* transient RPC error; retry next tick */ }
  }

  const timer = setInterval(() => { tick(); }, POLL_MS);
  if (timer.unref) timer.unref();
  tick();
  return timer;
}

// ---- guarded withdraw (money LEAVES the treasury — the most safety-critical path) ----
// Invariants enforced, in order: never send when PAUSED, over caps, or insufficient;
// debit the player's REAL balance BEFORE sending; roll the debit back if the send
// throws; never double-send on a COMPLETED idemKey. `sendFn` is injectable so tests
// drive a fake; production lazily builds + signs the real SPL transfer.
//
// Idempotency contract (money-safety critical):
//   - A key is burned (markSig) ONLY after a successful send. So a failed/rejected
//     withdraw is RETRYABLE with the SAME idemKey (it never counted, never debited).
//   - A true replay of a COMPLETED withdraw returns {ok,replay} without re-sending.
//   - Two concurrent calls with the same key: the second returns {ok:false,in_flight}.
const inFlight = new Set();            // idemSlots currently being processed (single-process)
const lastWd = new Map();              // wallet -> ts of last SUCCESSFUL withdraw (cooldown)

async function withdraw({ wallet, amount, idemKey }, store, sendFn) {
  if (!sendFn) sendFn = defaultSendFn; // production: lazy real SPL transfer (not used in tests)
  const cfg = config();
  if (cfg.PAUSED) return { ok: false, reason: "paused" };

  // ---- validation (cheap, before any state mutation) ----
  if (!wallet) return { ok: false, reason: "invalid" };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: "invalid" };
  if (amount < cfg.MIN_WITHDRAW) return { ok: false, reason: "min" };
  if (amount > cfg.MAX_PER_TX) return { ok: false, reason: "max" };

  // ---- idempotency: only a COMPLETED withdraw has burned the slot ----
  const slot = "wd:" + idemKey;
  if (store.hasSig(slot)) return { ok: true, replay: true };  // already completed once
  if (inFlight.has(slot)) return { ok: false, reason: "in_flight" };
  inFlight.add(slot);
  try {
    // ---- cooldown (per wallet) ----
    if (cfg.COOLDOWN_MS > 0 && Date.now() - (lastWd.get(wallet) || 0) < cfg.COOLDOWN_MS) {
      return { ok: false, reason: "cooldown" };               // retryable; key NOT burned
    }

    // ---- daily cap (uncapped per-UTC-day tally; exact regardless of ledger truncation) ----
    const dayKey = new Date().toISOString().slice(0, 10);     // YYYY-MM-DD (UTC)
    if (store.withdrawnToday(wallet, dayKey) + amount > cfg.DAILY_CAP) {
      return { ok: false, reason: "daily_cap" };              // retryable; key NOT burned
    }

    // ---- balance ----
    const bal = store.getBalance(wallet, 0, "real");
    if (!(bal >= amount)) return { ok: false, reason: "insufficient" }; // key NOT burned

    // ---- DEBIT FIRST, then send ----
    store.setBalance(wallet, bal - amount, null, "real");
    store.ledger(wallet, -amount, "withdraw", "real");
    try {
      const sig = await sendFn({ to: wallet, amount });
      // SUCCESS: burn the key, record the day-tally + cooldown. Only now is it spent.
      store.markSig(slot);
      store.addWithdrawnToday(wallet, dayKey, amount);
      lastWd.set(wallet, Date.now());
      return { ok: true, sig };
    } catch (e) {
      // ROLLBACK: re-credit using the current balance (avoid a stale `bal`). The key
      // is NOT burned and the day-tally is NOT bumped, so a retry with the same
      // idemKey is allowed and counts nothing against the cap.
      const now2 = store.getBalance(wallet, 0, "real");
      store.setBalance(wallet, now2 + amount, null, "real");
      store.ledger(wallet, +amount, "withdraw-rollback", "real");
      return { ok: false, reason: "send_failed" };
    }
  } finally {
    inFlight.delete(slot);
  }
}

// Default production sender (NOT exercised by tests; only reached when no sendFn is
// injected). Lazily builds + signs a real SPL transfer of `amount` base units of
// KABOOM_MINT from the treasury to the recipient's ATA (creating it if missing),
// sends and confirms, and returns the signature. No @solana import at module load.
async function defaultSendFn({ to, amount }) {
  const web3 = require("@solana/web3.js");
  const splToken = require("@solana/spl-token");
  const bs58 = require("bs58").default || require("bs58");

  const conn = new web3.Connection(process.env.SOLANA_RPC, "confirmed");
  const mintPk = new web3.PublicKey(process.env.KABOOM_MINT);
  const treasuryKp = web3.Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_SECRET));
  const toPk = new web3.PublicKey(to);

  const baseUnits = amount * UNIT; // `amount` is whole $KABOOM -> convert to on-chain base units
  const fromAta = await splToken.getOrCreateAssociatedTokenAccount(
    conn, treasuryKp, mintPk, treasuryKp.publicKey
  );
  // Pre-check treasury balance so a shortfall rolls back cleanly (clear reason)
  // instead of failing mid-transfer on-chain with a confusing error.
  const treasuryBal = Number((fromAta.amount != null ? fromAta.amount : 0n).toString());
  if (!(treasuryBal >= baseUnits)) throw new Error("treasury_insufficient");
  const toAta = await splToken.getOrCreateAssociatedTokenAccount(
    conn, treasuryKp, mintPk, toPk
  );
  const sig = await splToken.transfer(
    conn, treasuryKp, fromAta.address, toAta.address, treasuryKp.publicKey, baseUnits
  );
  return sig;
}

// ---- in-app deposit (build + relay) ----
// The user can't move SPL tokens from an embedded (Privy) wallet without a UI, so the
// server BUILDS an unsigned transfer (it has the RPC + mint + treasury address), the client
// has the user's wallet SIGN it, then the server RELAYS the signed tx (so the RPC key never
// reaches the client). The server can't move funds: only the user's signature authorizes it.
async function buildDepositTx({ fromWallet, amount }) {
  if (!fromWallet || !Number.isInteger(amount) || amount <= 0) throw new Error("invalid");
  const web3 = require("@solana/web3.js");
  const splToken = require("@solana/spl-token");
  const bs58 = require("bs58").default || require("bs58");
  const conn = new web3.Connection(process.env.SOLANA_RPC, "confirmed");
  const mintPk = new web3.PublicKey(process.env.KABOOM_MINT);
  const treasuryKp = web3.Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_SECRET));
  const treasuryPk = treasuryKp.publicKey;
  const fromPk = new web3.PublicKey(fromWallet);
  const baseUnits = amount * UNIT; // whole $KABOOM -> base units
  const fromAta = await splToken.getAssociatedTokenAddress(mintPk, fromPk);
  const treasuryAta = await splToken.getAssociatedTokenAddress(mintPk, treasuryPk);
  const ixs = [
    // ensure the treasury ATA exists (no-op if it already does); TREASURY pays its rent
    splToken.createAssociatedTokenAccountIdempotentInstruction(treasuryPk, treasuryAta, treasuryPk, mintPk),
    splToken.createTransferInstruction(fromAta, treasuryAta, fromPk, baseUnits), // authority = depositing user
  ];
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  // Treasury is the FEE PAYER so the depositing wallet needs NO SOL — critical for fresh Privy
  // embedded wallets (which start with 0 SOL). Treasury signs the fee slot here; the client adds
  // the user's transfer-authority signature. Treasury can't move anyone's funds: the transfer's
  // authority is the user, who must also sign.
  const tx = new web3.Transaction({ feePayer: treasuryPk, recentBlockhash: blockhash }).add(...ixs);
  tx.partialSign(treasuryKp);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
async function submitSignedTx(b64) {
  const web3 = require("@solana/web3.js");
  const conn = new web3.Connection(process.env.SOLANA_RPC, "confirmed");
  const raw = Buffer.from(String(b64 || ""), "base64");
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  return sig; // the deposit watcher credits it once confirmed
}

module.exports = { enabled, config, creditDeposit, parseIncoming, _fakeTx, startWatcher, withdraw, buildDepositTx, submitSignedTx };
