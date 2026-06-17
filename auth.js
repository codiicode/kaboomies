/* Verifies a Solana wallet login signature.
   The client signs a short login message with their wallet (Phantom signMessage).
   We verify it against the wallet's public key so a player can only claim a
   balance for a wallet they actually control. Replay is limited by requiring a
   fresh timestamp in the message (a server-issued nonce is the next hardening
   step). */
const nacl = require("tweetnacl");
const bs58 = require("bs58").default || require("bs58");

const MAX_AGE_MS = 5 * 60 * 1000;
const PREFIX = "KABOOMIES login";

function loginMessage(wallet, ts) {
  return `${PREFIX}\nwallet: ${wallet}\nts: ${ts}`;
}

// signature: number[] (raw bytes from wallet.signMessage). wallet: base58 pubkey.
function verify(wallet, ts, signature) {
  try {
    if (!wallet || !ts || !signature) return false;
    if (Math.abs(Date.now() - Number(ts)) > MAX_AGE_MS) return false;
    const pk = bs58.decode(wallet);
    if (pk.length !== 32) return false;
    const sig = Uint8Array.from(signature);
    if (sig.length !== 64) return false;
    const msg = new TextEncoder().encode(loginMessage(wallet, ts));
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch (e) { return false; }
}

module.exports = { verify, loginMessage, PREFIX };
