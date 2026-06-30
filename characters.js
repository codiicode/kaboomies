/* Pure character-unlock logic. Hero is always unlocked; the other characters
   unlock from persistent stats (verified wallets only). No IO. XP-only economy. */

const DEFAULT_BASE = "hero";
// Starter characters: always unlocked for everyone, no stat requirement.
const STARTER_BASES = ["hero", "earl"];

// stat is a key of the stats object, or "level"; target is the threshold (>=).
const CHARACTER_REQS = [
  { base: "house",  name: "Chillhouse",     label: "Play 10 games",    stat: "games",  target: 10   },
  { base: "sahur",  name: "Tung Sahur",     label: "Win 20 rounds",    stat: "wins",   target: 20   },
  { base: "popcat", name: "Popcat",         label: "Break 500 crates", stat: "crates", target: 500  },
  { base: "wif",    name: "WIF",            label: "Get 300 kills",    stat: "kills",  target: 300  },
  { base: "bull",   name: "Ansem The Black Bull", label: "Win 75 rounds", stat: "wins", target: 75   },
  { base: "mitch",  name: "MITCH",          label: "Play 100 games",   stat: "games",  target: 100  },
  { base: "alon",   name: "ALON",           label: "Get 1000 kills",   stat: "kills",  target: 1000 },
].map(Object.freeze);
Object.freeze(CHARACTER_REQS);

function statValue(s, key) { return (s && typeof s[key] === "number") ? s[key] : 0; }

function isUnlocked(base, s) {
  if (STARTER_BASES.includes(base)) return true;
  const req = CHARACTER_REQS.find(r => r.base === base);
  if (!req) return false;
  return statValue(s, req.stat) >= req.target;
}

// s = {games,kills,wins,crates,pickups,level}; returns the full roster (starters first).
function unlockState(s) {
  const hero = { base: "hero", name: "Hero", label: "Starter", stat: null, target: 0, prog: 0, unlocked: true };
  const earl = { base: "earl", name: "Earl", label: "Starter", stat: null, target: 0, prog: 0, unlocked: true };
  const rest = CHARACTER_REQS.map(r => {
    const prog = statValue(s, r.stat);
    return { base: r.base, name: r.name, label: r.label, stat: r.stat, target: r.target, prog, unlocked: prog >= r.target };
  });
  return [hero, earl, ...rest];
}

module.exports = { DEFAULT_BASE, STARTER_BASES, CHARACTER_REQS, isUnlocked, unlockState, statValue };
