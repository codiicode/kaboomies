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
module.exports = { enabled, config };
