/* Pure character-unlock logic. Hero is always unlocked; the other characters
   unlock from persistent stats (verified wallets only). No IO. XP-only economy. */

const DEFAULT_BASE = "hero";

// stat is a key of the stats object, or "level"; target is the threshold (>=).
const CHARACTER_REQS = [
  { base: "house",  name: "Chillhouse",     label: "Play 3 games",     stat: "games",  target: 3   },
  { base: "popcat", name: "Popcat",         label: "Break 100 crates", stat: "crates", target: 100 },
  { base: "sahur",  name: "Tung Sahur",     label: "Win 5 rounds",     stat: "wins",   target: 5   },
  { base: "alon",   name: "ALON",           label: "Play 25 games",    stat: "games",  target: 25  },
  { base: "mitch",  name: "MITCH",          label: "Reach Level 5",    stat: "level",  target: 5   },
  { base: "wif",    name: "WIF",            label: "Get 100 kills",    stat: "kills",  target: 100 },
  { base: "bull",   name: "Ansem The Black Bull", label: "Win 25 rounds", stat: "wins", target: 25  },
].map(Object.freeze);
Object.freeze(CHARACTER_REQS);

function statValue(s, key) { return (s && typeof s[key] === "number") ? s[key] : 0; }

function isUnlocked(base, s) {
  if (base === DEFAULT_BASE) return true;
  const req = CHARACTER_REQS.find(r => r.base === base);
  if (!req) return false;
  return statValue(s, req.stat) >= req.target;
}

// s = {games,kills,wins,crates,pickups,level}; returns 8 entries (hero first).
function unlockState(s) {
  const hero = { base: "hero", name: "Hero", label: "Starter", stat: null, target: 0, prog: 0, unlocked: true };
  const rest = CHARACTER_REQS.map(r => {
    const prog = statValue(s, r.stat);
    return { base: r.base, name: r.name, label: r.label, stat: r.stat, target: r.target, prog, unlocked: prog >= r.target };
  });
  return [hero, ...rest];
}

module.exports = { DEFAULT_BASE, CHARACTER_REQS, isUnlocked, unlockState, statValue };
