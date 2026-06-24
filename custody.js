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

module.exports = { enabled, config, creditDeposit };
