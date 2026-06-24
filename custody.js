"use strict";
// Real-money custody for $KABOOM. INERT unless all three env vars are set.
// All chain/treasury-key code is lazy-loaded so tests + the gated-off server never touch Solana libs.
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
  if (!sig || !fromWallet || !(amount > 0)) return false;
  if (store.seenSig(sig)) return false;            // idempotent: already credited
  const cur = "real";
  store.setBalance(fromWallet, store.getBalance(fromWallet, 0, cur) + amount, null, cur);
  store.ledger(fromWallet, amount, "deposit", cur);
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
    return k == null ? null : (typeof k === "string" ? k : (k.pubkey || null));
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
  const bs58 = require("bs58");

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

module.exports = { enabled, config, creditDeposit, parseIncoming, _fakeTx, startWatcher };
