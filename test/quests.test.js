const test = require("node:test");
const assert = require("node:assert");
const q = require("../quests");

test("dayIndex is a contiguous UTC day number", () => {
  assert.strictEqual(q.dayIndex(0), 0);
  assert.strictEqual(q.dayIndex(86400000), 1);
  assert.strictEqual(q.dayIndex(86400000 * 100 + 123), 100);
});

test("todaysQuests returns exactly 3 distinct quests from the pool", () => {
  const day = 20100;
  const picks = q.todaysQuests(day);
  assert.strictEqual(picks.length, 3);
  const ids = picks.map(p => p.id);
  assert.strictEqual(new Set(ids).size, 3);
  for (const p of picks) assert.ok(q.QUEST_POOL.find(d => d.id === p.id));
});

test("todaysQuests is deterministic for a given day and varies by day", () => {
  assert.deepStrictEqual(q.todaysQuests(20100), q.todaysQuests(20100));
  const a = q.todaysQuests(20100).map(p => p.id).join(",");
  let varies = false;
  for (let d = 20100; d < 20140; d++) {
    if (q.todaysQuests(d).map(p => p.id).join(",") !== a) { varies = true; break; }
  }
  assert.ok(varies, "quest set should change across days");
});

test("nextStreak: first ever grants day 1 = 50 XP", () => {
  const r = q.nextStreak(null, 100);
  assert.deepStrictEqual(r, { count: 1, best: 1, day: 100, xpAwarded: 50 });
});

test("nextStreak: consecutive day increments and scales XP", () => {
  const r = q.nextStreak({ count: 1, best: 1, day: 100 }, 101);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.xpAwarded, 75);
  assert.strictEqual(r.best, 2);
});

test("nextStreak: same day grants nothing", () => {
  const r = q.nextStreak({ count: 3, best: 5, day: 100 }, 100);
  assert.deepStrictEqual(r, { count: 3, best: 5, day: 100, xpAwarded: 0 });
});

test("nextStreak: gap resets to 1 but keeps best", () => {
  const r = q.nextStreak({ count: 6, best: 6, day: 100 }, 103);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.best, 6);
  assert.strictEqual(r.xpAwarded, 50);
});

test("nextStreak: XP caps at 200", () => {
  const r = q.nextStreak({ count: 20, best: 20, day: 100 }, 101);
  assert.strictEqual(r.xpAwarded, 200);
});
