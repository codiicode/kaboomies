/* Pure daily-quest + login-streak logic (no IO, unit-tested).
   Rewards are XP only; account level is prestige (no combat power). */

// frozen so importing code can't mutate the shared pool (would corrupt todaysQuests)
const QUEST_POOL = [
  { id: "win",     label: "Win a round",      target: 1,  xp: 150 },
  { id: "kills",   label: "Get 5 kills",      target: 5,  xp: 100 },
  { id: "crates",  label: "Break 25 crates",  target: 25, xp: 75  },
  { id: "pickups", label: "Grab 6 power-ups", target: 6,  xp: 75  },
  { id: "games",   label: "Play 4 rounds",    target: 4,  xp: 75  },
].map(Object.freeze);
Object.freeze(QUEST_POOL);

// contiguous UTC day number (unlike YYYYMMDD dailySeed) -> clean streak math
function dayIndex(now) { return Math.floor(now / 86400000); }

// deterministic PRNG so all players get the same 3 quests on a given day
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function todaysQuests(dayIdx) {
  const pool = QUEST_POOL.slice();
  const rand = lcg((dayIdx >>> 0) + 1);
  for (let i = pool.length - 1; i > 0; i--) {            // seeded Fisher–Yates
    const j = Math.floor(rand() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, 3);
}

// prev: {count,best,day} | null ; today: dayIndex. Returns next state + xpAwarded.
function nextStreak(prev, today) {
  const p = (prev && typeof prev.day === "number") ? prev : { count: 0, best: 0, day: -1 };
  if (p.day === today) return { count: p.count, best: p.best || 0, day: p.day, xpAwarded: 0 };
  const count = (p.day === today - 1) ? p.count + 1 : 1;
  const best = Math.max(p.best || 0, count);
  const xpAwarded = Math.min(50 + (count - 1) * 25, 200);
  return { count, best, day: today, xpAwarded };
}

module.exports = { QUEST_POOL, dayIndex, todaysQuests, nextStreak };
