/* KABOOMIES persistence.
   Default: a local JSON file (survives restarts, zero setup, fully testable).
   If SUPABASE_URL + SUPABASE_SERVICE_KEY are set, balances/wins are also
   upserted to a Supabase `players` table via REST (best-effort, async).

   Supabase table (SQL):
     create table players (
       wallet text primary key,
       name text,
       balance bigint default 1000,
       wins int default 0,
       updated_at timestamptz default now()
     );
*/
const fs = require("fs");
const path = require("path");

const FILE = process.env.KABOOM_DATA
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "kaboomies.json") : path.join(__dirname, "data.json"));
const SUPA_URL = process.env.SUPABASE_URL || "";
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const useSupa = !!(SUPA_URL && SUPA_KEY);

let mem = { balances: {}, wins: {}, names: {}, xp: {}, real: {}, stats: {}, streak: {}, quests: {} };
let saveTimer = null;

function loadFile() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    mem.balances = j.balances || {};
    mem.wins = j.wins || {};
    mem.names = j.names || {};
    mem.xp = j.xp || {};
    mem.real = j.real || {};
    mem.stats = j.stats || {};
    mem.streak = j.streak || {};
    mem.quests = j.quests || {};
  } catch (e) { /* fresh */ }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) {}
  }, 800);
}

async function supaUpsert(wallet, balance, name, wins) {
  if (!useSupa) return;
  try {
    const row = { wallet, balance, updated_at: new Date().toISOString() };
    if (name != null) row.name = name;
    if (wins != null) row.wins = wins;
    await fetch(SUPA_URL.replace(/\/$/, "") + "/rest/v1/players?on_conflict=wallet", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPA_KEY,
        "Authorization": "Bearer " + SUPA_KEY,
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
    });
  } catch (e) { /* best-effort */ }
}

async function init() {
  if (!useSupa) loadFile();
  // (Supabase mode reads lazily per-key + keeps the in-memory mirror.)
}

function getBalance(key, dflt, cur) {
  const m = cur === "real" ? mem.real : mem.balances;
  return (key in m) ? m[key] : dflt;
}
function setBalance(key, val, name, cur) {
  if (cur === "real") mem.real[key] = val; else mem.balances[key] = val;
  if (name) mem.names[key] = name;
  saveSoon();
  if (cur !== "real") supaUpsert(key, val, name, mem.wins[key]);
}
function bumpWin(key, name) {
  mem.wins[key] = (mem.wins[key] || 0) + 1;
  if (name) mem.names[key] = name;
  saveSoon();
  supaUpsert(key, mem.balances[key] || 0, name, mem.wins[key]);
  return mem.wins[key];
}
function topScores(n = 10) {
  return Object.keys(mem.balances)
    .map(k => ({ wallet: k, name: mem.names[k] || (k.startsWith("guest:") ? "Guest" : k.slice(0, 4) + "…" + k.slice(-4)), balance: mem.balances[k], wins: mem.wins[k] || 0, level: levelFromXp(mem.xp[k] || 0) }))
    .filter(r => !r.wallet.startsWith("guest:"))
    .sort((a, b) => b.balance - a.balance || b.wins - a.wins)
    .slice(0, n);
}

// ---- levels: persistent account XP -> level (prestige only, no combat power) ----
function getXp(key) { return mem.xp[key] || 0; }
function addXp(key, amt) {
  if (!key || !amt) return mem.xp[key] || 0;
  mem.xp[key] = (mem.xp[key] || 0) + amt;
  saveSoon();
  return mem.xp[key];
}
// cost to advance from level L to L+1 is 1000 + (L-1)*600 (~10x — leveling is a long grind)
function levelFromXp(xp) {
  let lvl = 1, need = 1000;
  xp = xp || 0;
  while (xp >= need) { xp -= need; lvl++; need = 1000 + (lvl - 1) * 600; }
  return lvl;
}
// progress within the current level: { level, into, need }
function levelProgress(xp) {
  let lvl = 1, need = 1000; xp = xp || 0;
  while (xp >= need) { xp -= need; lvl++; need = 1000 + (lvl - 1) * 600; }
  return { level: lvl, into: xp, need };
}

// ---- per-account stats / streak / quests (verified wallets only; XP-only economy) ----
function isWalletKey(key) { return !!key && !key.startsWith("guest:") && !key.startsWith("bot:"); }

function getStats(key) {
  const s = mem.stats[key] || {};
  return { games: s.games || 0, kills: s.kills || 0, deaths: s.deaths || 0,
           crates: s.crates || 0, pickups: s.pickups || 0 };
}
const STAT_FIELDS = new Set(["games", "kills", "deaths", "crates", "pickups"]);
function bumpStat(key, field, n = 1) {
  if (!isWalletKey(key) || !STAT_FIELDS.has(field)) return; // allowlist: never persist stray fields
  const s = mem.stats[key] || (mem.stats[key] = {});
  s[field] = (s[field] || 0) + n;
  saveSoon();
}

function getStreak(key) {
  const s = mem.streak[key];
  return s ? { count: s.count || 0, best: s.best || 0, day: typeof s.day === "number" ? s.day : -1 }
           : { count: 0, best: 0, day: -1 };
}
function setStreak(key, st) {
  if (!isWalletKey(key)) return;
  mem.streak[key] = { count: st.count, best: st.best, day: st.day };
  saveSoon();
}

// returns a COPY of {day,prog,done}; resets (and persists) when the stored day != today.
// callers mutate the copy then persist via setQuestState (so mem is never dirtied behind saveSoon).
function getQuestState(key, today) {
  if (!isWalletKey(key)) return { day: today, prog: {}, done: {} };
  let q = mem.quests[key];
  if (!q || q.day !== today) { q = { day: today, prog: {}, done: {} }; mem.quests[key] = q; saveSoon(); }
  return { day: q.day, prog: { ...q.prog }, done: { ...q.done } };
}
function setQuestState(key, q) {
  if (!isWalletKey(key)) return;
  mem.quests[key] = { day: q.day, prog: q.prog || {}, done: q.done || {} };
  saveSoon();
}

function getWins(key) { return mem.wins[key] || 0; }
function getName(key) { return mem.names[key] || null; }

module.exports = { init, getBalance, setBalance, bumpWin, topScores, getXp, addXp, levelFromXp, levelProgress, useSupa,
  getStats, bumpStat, getStreak, setStreak, getQuestState, setQuestState, getWins, getName };
