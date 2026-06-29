/* KABOOMIES — authoritative multiplayer server (kaboomies.fun)
   Rooms (one per map), continuous movement, bombs, and a $KABOOM token economy:
   every time a player is bombed they drop tokens that others can pick up.
   Core game logic is exported so it can be unit-tested; the HTTP+WS server
   only runs when this file is executed directly. */

// ---------- shared constants ----------
const TILE = 44;
const FUSE = 2400;        // ms bomb fuse
const BLAST = 460;        // ms explosion visible / deadly
const TICK = 1000 / 60;   // sim step
const SNAP = 1000 / 30;   // broadcast rate (fresher positions -> snappier movement)
const HB = TILE * 0.30;   // player half-box for collision (smaller = easier to slip through 1-wide gaps / round corners)
const START_BAL = 1000;   // starting $KABOOM for a fresh wallet
const DEATH_DROP = 100;   // $KABOOM dropped on death
const SPEED_BASE = 2.9, SPEED_CAP = 4.4, SPEED_STEP = 0.3;
const SUDDEN_AFTER = 60000; // ms before the arena starts closing in (grace period)
const CLOSE_EVERY = 10000;  // (legacy, unused — closing is now a telegraphed one-tile-at-a-time spiral)
const CLOSE_STEP = 300;     // ms between telegraphing each single tile (one at a time, outside-in spiral)
const WARN_MS = 1300;       // telegraph time: a tile flashes this long before it turns into a wall
const POT_SHARE = 0.4;      // fraction of each death-drop that feeds the round pot
const BOUNTY_STEP = 30;     // extra $KABOOM dropped per kill in a streak
const BOUNTY_MAX = 240;     // cap on bounty bonus
const MAX_HP = 100;         // everyone starts each round at 100 HP
const DMG_CORE = 100;       // blast damage on the bomb tile + tiles adjacent to it (instant kill)
const DMG_EDGE = 50;        // blast damage further out along the arm (two hits to kill)
const XP_KILL = 25, XP_WIN = 100, XP_CRATE = 2; // account-level XP rewards (loot pickups give no XP)
const GAME_ROUNDS = 5;      // wager games are best-of: this many rounds per game before payout
const LOBBY_COUNTDOWN_MS = 60000; // wager: fill window once >=MIN are present (lets a room fill toward MAX before starting)
const LOBBY_FULL_MS = 3000;       // wager: once the room is FULL (MAX_PLAYERS), start within this instead of waiting out the window
const MIN_WAGER_PLAYERS = 2;      // wager: a game never starts (and nobody is charged) below this

// --- Skull curses (Atomic-Bomberman style): grab the skull -> a random temporary curse.
// Touch a clean player to pass it on (hot-potato) and cure yourself. One curse at a time,
// per-round, never touches balances. Speed curses report through effSpeed so the client's
// prediction auto-syncs; reverse/nobomb are mirrored client-side from the snapshot `cu`. ---
const CURSE_MS = 9000, CURSE_IMMUNE_MS = 700;
const HYPER_MULT = 1.9, SLOW_MULT = 0.5;
const CURSES = ["reverse", "hyper", "slow", "nobomb", "shortflame"];
function effSpeed(p) { return p.curse === "hyper" ? p.speed * HYPER_MULT : p.curse === "slow" ? p.speed * SLOW_MULT : p.speed; }
function applyCurse(room, pl, type) { pl.curse = type; pl.curseT = CURSE_MS; pl.curseImmune = CURSE_IMMUNE_MS; pushEvent(room, { k: "curse", who: pl.name, type }); }

const store = require("./store");
const auth = require("./auth");
const quests = require("./quests");
const characters = require("./characters");
const custody = require("./custody.js"); // safe to require: no @solana loaded unless real-money is enabled

// Each map is its own room. One row taller than before.
const MAPS = {
  casual:     { name: "Rookie Ring", cols: 33, rows: 17, density: 0.70, deathDrop: 10, wager: true, buyIn: 500, deathStake: 100, rake: 0.05 },   // low stakes
  brawl:      { name: "Brawl Arena", cols: 35, rows: 18, density: 0.70, deathDrop: 100, wager: true, buyIn: 5000, deathStake: 1000, rake: 0.05 },  // mid stakes (default)
  highroller: { name: "High Roller", cols: 37, rows: 19, density: 0.72, deathDrop: 1000, wager: true, buyIn: 50000, deathStake: 10000, rake: 0.05 }, // high stakes
};

function dailySeed() {
  const d = new Date();
  return (d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()) >>> 0;
}
const DEFAULT_MAP = "brawl";
const MAX_PLAYERS = 6; // per arena instance; rooms auto-shard (roomFor opens a new one when full)

const balances = new Map(); // (cur|walletKey) -> number (live cache backed by store)

// Real-money mode is OFF until the $KABOOM token + treasury + RPC are configured.
const REAL_MONEY_ENABLED = !!(process.env.KABOOM_MINT && process.env.TREASURY_SECRET && process.env.SOLANA_RPC);

function bal(key, cur) {
  const ck = (cur === "real" ? "real|" : "play|") + key;
  if (!balances.has(ck)) balances.set(ck, store.getBalance(key, cur === "real" ? 0 : START_BAL, cur));
  return balances.get(ck);
}
function setBal(key, v, name, cur) {
  v = Math.max(0, Math.round(v));
  balances.set((cur === "real" ? "real|" : "play|") + key, v);
  store.setBalance(key, v, name, cur);
}

// ---------- grid ----------
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1)); // inclusive

// classic even/even pillar lattice — always connected (used as safe fallback)
function latticeGrid(cols, rows, density) {
  const g = [];
  for (let r = 0; r < rows; r++) {
    g[r] = [];
    for (let c = 0; c < cols; c++) {
      let t;
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) t = 1;
      else if (r % 2 === 0 && c % 2 === 0) t = 1;
      else t = Math.random() < density ? 2 : 0;
      g[r][c] = t;
    }
  }
  return g;
}

// scatter indestructible obstacles with 180° rotational symmetry (fair for all spawns)
function placeObstacles(g, cols, rows) {
  const put = (c, r) => {
    for (const [x, y] of [[c, r], [cols - 1 - c, rows - 1 - r]])
      if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) g[y][x] = 1;
  };
  const style = ri(0, 6);
  if (style === 0) {                              // dense jittered pillar field
    for (let r = 2; r < rows - 1; r += 2)
      for (let c = 2; c < cols - 1; c += 2)
        if (Math.random() < 0.9) put(c + (Math.random() < 0.3 ? 1 : 0), r);
  } else if (style === 1) {                       // scattered small blocks
    const n = Math.floor((cols * rows) / 26);
    for (let i = 0; i < n; i++) {
      const c = ri(2, cols - 3), r = ri(2, rows - 3);
      put(c, r); if (Math.random() < 0.55) put(c + 1, r); if (Math.random() < 0.45) put(c, r + 1);
    }
  } else if (style === 2) {                        // short wall segments
    const n = Math.max(4, Math.floor(cols / 3));
    for (let i = 0; i < n; i++) {
      const horiz = Math.random() < 0.5, len = ri(2, 5);
      const c = ri(2, cols - 3), r = ri(2, rows - 3);
      for (let k = 0; k < len; k++) put(c + (horiz ? k : 0), r + (horiz ? 0 : k));
    }
  } else if (style === 3) {                         // a few room outlines
    for (let i = 0; i < 3; i++) {
      const w = ri(3, 6), h = ri(2, 4);
      const c = ri(2, Math.max(2, cols - 3 - w)), r = ri(2, Math.max(2, rows - 3 - h));
      for (let k = 0; k < w; k++) { put(c + k, r); put(c + k, r + h); }
      for (let k = 0; k <= h; k++) { put(c, r + k); put(c + w - 1, r + k); }
    }
  } else if (style === 4) {                         // diagonal stripes
    const gap = ri(3, 4);
    for (let r = 2; r < rows - 1; r++)
      for (let c = 2; c < cols - 1; c++)
        if ((c + r) % gap === 0 && Math.random() < 0.6) put(c, r);
  } else if (style === 5) {                         // plus / cross clusters
    const n = Math.max(3, Math.floor(cols / 6));
    for (let i = 0; i < n; i++) {
      const c = ri(3, cols - 4), r = ri(3, rows - 4);
      put(c, r); put(c + 1, r); put(c - 1, r); put(c, r + 1); put(c, r - 1);
    }
  } else {                                          // rutindelade chambers
    for (let r = 3; r < rows - 2; r += 3)
      for (let c = 3; c < cols - 2; c += 3) {
        put(c, r); if (Math.random() < 0.5) put(c + 1, r); if (Math.random() < 0.5) put(c, r + 1);
      }
  }
}

function genGrid(cols, rows, density) {
  const g = [];
  for (let r = 0; r < rows; r++) {
    g[r] = [];
    for (let c = 0; c < cols; c++)
      g[r][c] = (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) ? 1 : 0;
  }
  placeObstacles(g, cols, rows);
  // fill remaining open interior with destructible crates
  for (let r = 1; r < rows - 1; r++)
    for (let c = 1; c < cols - 1; c++)
      if (g[r][c] === 0 && Math.random() < density) g[r][c] = 2;
  return g;
}

// flood fill over passable cells (everything that isn't an indestructible wall);
// crates count as passable since they can be bombed through.
function connected(g, cols, rows, sp) {
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const st = sp[0]; if (g[st.r][st.c] === 1) return false;
  const q = [[st.c, st.r]]; seen[st.r][st.c] = true;
  while (q.length) {
    const [c, r] = q.pop();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen[nr][nc] || g[nr][nc] === 1) continue;
      seen[nr][nc] = true; q.push([nc, nr]);
    }
  }
  for (const s of sp) if (!seen[s.r][s.c]) return false;
  return true;
}

// assemble a full, playable round layout (fresh obstacles each call)
function generateRoom(cols, rows, density) {
  const sp = spawns(cols, rows);
  for (let a = 0; a < 20; a++) {
    const g = genGrid(cols, rows, density);
    monument(g, cols, rows);
    clearSpawns(g, cols, rows, sp);   // clear AFTER monument so it can't re-block a spawn
    if (connected(g, cols, rows, sp)) return g;
  }
  const g = latticeGrid(cols, rows, density); // guaranteed-connected fallback
  monument(g, cols, rows);
  clearSpawns(g, cols, rows, sp);
  return g;
}

function spawns(cols, rows) {
  const snap = (n, max) => { n = Math.round(n); if (n < 1) n = 1; if (n > max - 2) n = max - 2;
    if (n % 2 === 0) n += (n + 1 <= max - 2 ? 1 : -1); return n; };
  // ordered far-apart first: corners, edge midpoints, then interior
  const fr = [
    [0.05, 0.07], [0.95, 0.07], [0.05, 0.93], [0.95, 0.93],
    [0.50, 0.07], [0.50, 0.93], [0.05, 0.50], [0.95, 0.50],
    [0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72],
  ];
  const out = [], seen = new Set();
  for (const [fc, fri] of fr) {
    const c = snap(fc * (cols - 1), cols), r = snap(fri * (rows - 1), rows);
    const k = c + "," + r;
    if (!seen.has(k)) { seen.add(k); out.push({ c, r }); }
  }
  return out;
}

function clearSpawns(grid, cols, rows, sp) {
  for (const s of sp) {
    // Open the spawn tile + its whole orthogonal ring — clearing BOTH crates and stray
    // indestructible walls. This guarantees every spawn has at least an L of open tiles
    // (a vertical + a horizontal exit), so you can always step out and bomb-and-retreat
    // safely instead of being boxed in and forced to suicide.
    const cells = [[s.c, s.r], [s.c + 1, s.r], [s.c - 1, s.r], [s.c, s.r + 1], [s.c, s.r - 1]];
    for (const [c, r] of cells)
      if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) grid[r][c] = 0;
  }
}

// Central obstacle the leaderboard sits on: a small 3x3 solid core with an
// open ring around it so players can always walk around it.
function monument(grid, cols, rows) {
  const cc = Math.floor(cols / 2), cr = Math.floor(rows / 2);
  for (let r = cr - 2; r <= cr + 2; r++)
    for (let c = cc - 3; c <= cc + 3; c++)
      if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) grid[r][c] = 0; // open plaza
  for (let r = cr - 1; r <= cr + 1; r++)
    for (let c = cc - 2; c <= cc + 2; c++)
      if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) grid[r][c] = 1; // solid 5x3 core
}

// ---------- room ----------
function makeRoom(mapId, mode) {
  const cfg = MAPS[mapId] || MAPS[DEFAULT_MAP];
  const cols = cfg.cols, rows = cfg.rows;
  const grid = generateRoom(cols, rows, cfg.density);
  const m = mode === "real" ? "real" : "play";
  const startWaiting = (m === "real") && !!cfg.wager; // wager rooms open in the lobby, not mid-fight
  return {
    mapId: MAPS[mapId] ? mapId : DEFAULT_MAP,
    mode: m, cur: m === "real" ? "real" : "play",
    cols, rows, W: cols * TILE, H: rows * TILE,
    deathDrop: cfg.deathDrop != null ? cfg.deathDrop : DEATH_DROP,
    grid, seed: cfg.daily ? dailySeed() : ((Math.random() * 1e9) | 0),
    bombs: [], fires: [], ups: [], drops: [], destroyed: [], walls: [], events: [],
    players: new Map(), pot: 0,
    gameRound: 1, roundWins: new Map(),
    phase: startWaiting ? "waiting" : "playing", countdownMs: 0, winner: "", bombId: 1, roundTimer: null,
    elapsed: 0, sudden: false, closeOrder: null, closeIdx: 0, pendingWalls: [], closeTimer: 0,
  };
}

function newRound(room) {
  const cfg = MAPS[room.mapId];
  const sp = spawns(room.cols, room.rows);
  room.grid = generateRoom(room.cols, room.rows, cfg.density);
  room.seed = cfg.daily ? dailySeed() : ((Math.random() * 1e9) | 0); // fresh look each round (daily pins to the day)
  room.bombs = []; room.fires = []; room.ups = []; room.drops = []; room.destroyed = []; room.walls = []; room.events = [];
  // wager pots accumulate across the GAME_ROUNDS rounds of a game; training resets each round
  room.bombId = 1; room.phase = "playing"; room.winner = ""; if (!isWagerGame(room)) room.pot = 0;
  room.elapsed = 0; room.sudden = false; room.closeOrder = null; room.closeIdx = 0; room.pendingWalls = []; room.closeTimer = 0;
  let i = 0;
  for (const p of room.players.values()) { resetPlayer(p, sp[i % sp.length]); if (p.spectating) p.alive = false; i++; }
  roundAnte(room);
  // NOTE: buy-ins are charged once at GAME start (startWagerGame), not per round — so a fresh
  // round here never re-charges. Spectators (joined mid-game) stay out until the next game.
  syncBots(room);
}

function isWagerGame(room) {
  const cfg = MAPS[room.mapId];
  return !!(room && room.cur === "real" && cfg && cfg.wager);
}

function pushEvent(room, ev) {
  room.events.push(ev);
  if (room.events.length > 12) room.events.shift();
}

// SUDDEN DEATH: a telegraphed spiral. Tiles close ONE AT A TIME from the outside in.
// Each tile is "warned" (room.pendingWalls, broadcast so the client can flash it) for
// WARN_MS before it actually turns into an indestructible wall — so players always see
// where the wall is coming and have time to move clear instead of dying with no notice.
function buildCloseOrder(room) {
  const order = []; let x0 = 1, y0 = 1, x1 = room.cols - 2, y1 = room.rows - 2;
  while (x0 <= x1 && y0 <= y1) { // clockwise spiral inward over the interior
    for (let c = x0; c <= x1; c++) order.push([c, y0]);
    for (let r = y0 + 1; r <= y1; r++) order.push([x1, r]);
    if (y1 > y0) for (let c = x1 - 1; c >= x0; c--) order.push([c, y1]);
    if (x1 > x0) for (let r = y1 - 1; r > y0; r--) order.push([x0, r]);
    x0++; y0++; x1--; y1--;
  }
  return order.filter(([c, r]) => room.grid[r][c] !== 1); // skip permanent pillars (no point warning a wall)
}
function solidifyTile(room, c, r) {
  if (room.grid[r][c] !== 1) { room.grid[r][c] = 1; room.walls.push({ c, r }); }
  for (let i = room.ups.length - 1; i >= 0; i--) if (room.ups[i].c === c && room.ups[i].r === r) room.ups.splice(i, 1);
  for (let i = room.drops.length - 1; i >= 0; i--) if (room.drops[i].c === c && room.drops[i].r === r) room.drops.splice(i, 1);
  for (const pl of room.players.values()) { // crush only whoever is still standing on it after the warning
    if (!pl.alive) continue;
    const pc = Math.round((pl.x - TILE / 2) / TILE), pr = Math.round((pl.y - TILE / 2) / TILE);
    if (pc === c && pr === r) { pl.alive = false; if (isRanked(room) && !pl.bot) store.bumpStat(pl.key, "deaths"); pushEvent(room, { k: "crush", who: pl.name }); settleDeath(room, pl, null); }
  }
}
function stepClosing(room, dt) {
  if (!room.closeOrder) room.closeOrder = buildCloseOrder(room);
  room.sudden = true;
  room.closeTimer += dt;
  while (room.closeTimer >= CLOSE_STEP && room.closeIdx < room.closeOrder.length) { // telegraph the next tile(s)
    room.closeTimer -= CLOSE_STEP;
    const cell = room.closeOrder[room.closeIdx++];
    room.pendingWalls.push({ c: cell[0], r: cell[1], at: room.elapsed + WARN_MS });
  }
  for (let i = room.pendingWalls.length - 1; i >= 0; i--) { // turn warned tiles solid once their telegraph elapses
    if (room.elapsed >= room.pendingWalls[i].at) { const w = room.pendingWalls[i]; room.pendingWalls.splice(i, 1); solidifyTile(room, w.c, w.r); }
  }
}

function resetPlayer(p, s) {
  p.x = s.c * TILE + TILE / 2;
  p.y = s.r * TILE + TILE / 2;
  p.alive = true;
  p.maxBombs = 1; p.range = 2; p.speed = SPEED_BASE;
  p.streak = 0; p.anted = false;
  p.maxHp = MAX_HP; p.hp = MAX_HP; p.hitBlasts = new Set();
  p.ignore = new Set(); p.in = {};
  p.tp = true; // signal the owning client to hard-snap its prediction here (respawn/teleport), not glide
  p.curse = null; p.curseT = 0; p.curseImmune = 0;
  p.ai = { tc: Math.round((p.x - TILE/2)/TILE), tr: Math.round((p.y - TILE/2)/TILE), flee: false };
}

function addPlayer(room, p) {
  const sp = spawns(room.cols, room.rows);
  const idx = room.players.size % sp.length;
  p.wins = p.wins || 0;
  p.boughtIn = false; // once-per-game buy-in flag; persists across rounds, reset only at game start
  p.paid = 0;         // amount charged for the current wager game (for refund on abandon)
  p.spectating = false; // joined mid-game -> waits out the current game, not charged
  resetPlayer(p, sp[idx]);
  room.players.set(p.id, p);
  if (!p.bot && !balances.has(p.key)) balances.set(p.key, START_BAL); // bots never get a balance row (kept off leaderboard)
  return p;
}

function solidTile(room, c, r) {
  if (c < 0 || r < 0 || c >= room.cols || r >= room.rows) return true;
  const t = room.grid[r][c];
  return t === 1 || t === 2;
}

function canBe(room, px, py, pl) {
  const x0 = px - HB, x1 = px + HB, y0 = py - HB, y1 = py + HB;
  const c0 = Math.floor(x0 / TILE), c1 = Math.floor(x1 / TILE);
  const r0 = Math.floor(y0 / TILE), r1 = Math.floor(y1 / TILE);
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      if (solidTile(room, c, r)) return false;
  for (const b of room.bombs) {
    if (pl.ignore.has(b.id)) continue;
    const tx0 = b.col * TILE, tx1 = tx0 + TILE, ty0 = b.row * TILE, ty1 = ty0 + TILE;
    if (x1 > tx0 + 2 && x0 < tx1 - 2 && y1 > ty0 + 2 && y0 < ty1 - 2) return false;
  }
  return true;
}

function movePlayer(room, pl) {
  if (!pl.alive) return;
  let dx = (pl.in.r ? 1 : 0) - (pl.in.l ? 1 : 0);
  let dy = (pl.in.d ? 1 : 0) - (pl.in.u ? 1 : 0);
  if (pl.curse === "reverse") { dx = -dx; dy = -dy; }   // cursed: controls flipped (mirrored client-side too)
  if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
  const sp = effSpeed(pl);                              // hyper/slow curses scale here AND in the snapshot
  if (dx) {
    const nx = pl.x + dx * sp;
    if (canBe(room, nx, pl.y, pl)) pl.x = nx;
    else {
      const ce = Math.round((pl.y - TILE / 2) / TILE) * TILE + TILE / 2;
      const ny = pl.y + Math.sign(ce - pl.y) * Math.min(sp, Math.abs(ce - pl.y));
      if (Math.abs(ce - pl.y) > 1 && canBe(room, nx, ny, pl)) { pl.x = nx; pl.y = ny; }
    }
  }
  if (dy) {
    const ny = pl.y + dy * sp;
    if (canBe(room, pl.x, ny, pl)) pl.y = ny;
    else {
      const ce = Math.round((pl.x - TILE / 2) / TILE) * TILE + TILE / 2;
      const nx = pl.x + Math.sign(ce - pl.x) * Math.min(sp, Math.abs(ce - pl.x));
      if (Math.abs(ce - pl.x) > 1 && canBe(room, nx, ny, pl)) { pl.y = ny; pl.x = nx; }
    }
  }
  // Lane auto-centering: while moving straight on one axis, glide toward the perpendicular
  // lane center (capped at one step) so you slot cleanly into gaps and round corners. Mirrored
  // verbatim in the client predictor (predStep) so prediction never fights the server.
  if (dx && !dy) {
    const ce = Math.round((pl.y - TILE / 2) / TILE) * TILE + TILE / 2, d = ce - pl.y;
    if (d) { const st = Math.sign(d) * Math.min(sp, Math.abs(d)); if (canBe(room, pl.x, pl.y + st, pl)) pl.y += st; }
  } else if (dy && !dx) {
    const ce = Math.round((pl.x - TILE / 2) / TILE) * TILE + TILE / 2, d = ce - pl.x;
    if (d) { const st = Math.sign(d) * Math.min(sp, Math.abs(d)); if (canBe(room, pl.x + st, pl.y, pl)) pl.x += st; }
  }
  for (const id of [...pl.ignore]) {
    const b = room.bombs.find(bb => bb.id === id);
    if (!b) { pl.ignore.delete(id); continue; }
    const tx0 = b.col * TILE, tx1 = tx0 + TILE, ty0 = b.row * TILE, ty1 = ty0 + TILE;
    const overlap = pl.x + HB > tx0 && pl.x - HB < tx1 && pl.y + HB > ty0 && pl.y - HB < ty1;
    if (!overlap) pl.ignore.delete(id);
  }
  const pc = Math.round((pl.x - TILE / 2) / TILE), pr = Math.round((pl.y - TILE / 2) / TILE);
  // powerups
  for (let i = room.ups.length - 1; i >= 0; i--) {
    if (room.ups[i].c === pc && room.ups[i].r === pr) {
      const k = room.ups[i].k; room.ups.splice(i, 1);
      if (k === "bomb") pl.maxBombs = Math.min(6, pl.maxBombs + 1);
      else if (k === "fire") pl.range = Math.min(8, pl.range + 1);
      else if (k === "speed") pl.speed = Math.min(SPEED_CAP, pl.speed + SPEED_STEP);
      else if (k === "skull") applyCurse(room, pl, CURSES[Math.floor(Math.random() * CURSES.length)]);
      if (k !== "skull" && isRanked(room)) { store.bumpStat(pl.key, "pickups"); bumpQuest(room, pl, "pickups"); }
    }
  }
  // $KABOOM token drops (reserved for wager rooms; always empty in training since settleDeath transfers directly)
  for (let i = room.drops.length - 1; i >= 0; i--) {
    if (room.drops[i].c === pc && room.drops[i].r === pr) {
      setBal(pl.key, bal(pl.key, room.cur) + room.drops[i].a, null, room.cur);
      room.drops.splice(i, 1);
    }
  }
}

function placeBomb(room, pl) {
  if (!pl.alive || room.phase !== "playing") return;
  if (pl.curse === "nobomb") return; // cursed: can't lay bombs
  const col = Math.round((pl.x - TILE / 2) / TILE);
  const row = Math.round((pl.y - TILE / 2) / TILE);
  if (col < 0 || row < 0 || col >= room.cols || row >= room.rows) return;
  if (room.grid[row][col] !== 0) return;
  if (room.bombs.some(b => b.col === col && b.row === row)) return;
  if (room.bombs.filter(b => b.owner === pl.id).length >= pl.maxBombs) return;
  const b = { id: room.bombId++, col, row, owner: pl.id, t: FUSE, range: pl.curse === "shortflame" ? 1 : pl.range };
  room.bombs.push(b);
  pl.ignore.add(b.id);
}

function explode(room, b) {
  const cells = [{ c: b.col, r: b.row, d: 0 }];
  const newUps = [];
  const ownerPlayer = room.players.get(b.owner) || null;
  const ownerKey = ownerPlayer ? ownerPlayer.key : undefined;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dc, dr] of dirs) {
    for (let i = 1; i <= b.range; i++) {
      const c = b.col + dc * i, r = b.row + dr * i;
      if (c < 0 || r < 0 || c >= room.cols || r >= room.rows) break;
      const t = room.grid[r][c];
      if (t === 1) break;
      cells.push({ c, r, d: i });
      if (t === 2) {
        room.grid[r][c] = 0;
        room.destroyed.push({ c, r });
        if (ownerPlayer && !ownerPlayer.bot) gainXp(room, ownerKey, XP_CRATE);
        if (isRanked(room)) { store.bumpStat(ownerKey, "crates"); bumpQuest(room, ownerPlayer, "crates"); }
        if (Math.random() < 0.30) {
          const pool = ["bomb", "bomb", "fire", "fire", "speed", "speed", "skull", "skull"]; // ~25% of drops are a risky skull
          newUps.push({ c, r, k: pool[Math.floor(Math.random() * pool.length)] });
        }
        break; // a crate absorbs the rest of the blast arm
      }
      const ob = room.bombs.find(x => x.col === c && x.row === r && x !== b);
      if (ob && ob.t > 0) ob.t = 0;
    }
  }
  const bid = (room.blastSeq = (room.blastSeq || 0) + 1);
  for (const cell of cells) {
    for (let i = room.ups.length - 1; i >= 0; i--)
      if (room.ups[i].c === cell.c && room.ups[i].r === cell.r) room.ups.splice(i, 1);
    // bomb tile + adjacent tiles are lethal (100); further out does 50 (two hits to kill)
    room.fires.push({ c: cell.c, r: cell.r, t: BLAST, owner: b.owner, bid, dmg: cell.d <= 1 ? DMG_CORE : DMG_EDGE });
  }
  for (const u of newUps) room.ups.push(u);
}

// account-level XP (prestige only). Emits a levelup event when a threshold is crossed.
function gainXp(room, key, amt) {
  if (!key || !amt) return;
  const before = store.levelFromXp(store.getXp(key));
  const after = store.levelFromXp(store.addXp(key, amt));
  if (after > before && room) {
    const pl = [...room.players.values()].find(p => p.key === key);
    pushEvent(room, { k: "levelup", who: pl ? pl.name : "Someone", lvl: after });
  }
}

// ---- profile / daily quests / login streak (verified wallets only; XP-only) ----
function buildQuests(key, today) {
  const q = store.getQuestState(key, today);
  return quests.todaysQuests(today).map(d => ({
    id: d.id, label: d.label, target: d.target, xp: d.xp,
    prog: q.prog[d.id] || 0, done: !!q.done[d.id],
  }));
}

// Sanitize a player-chosen name for a public game: strip control chars, cap length,
// and reject names containing slurs (leet-normalized match) -> fall back to "Player".
const NAME_BLOCK = ["nigger","nigga","faggot","retard","kike","spic","chink","tranny","rape","rapist","pedo","cunt","whore","coon","beaner","wetback","slut"];
function cleanName(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.split("").filter(c => c.charCodeAt(0) >= 32).join("").replace(/\s+/g, " ").trim().slice(0, 14);
  if (!s) return "Player";
  const norm = s.toLowerCase()
    .replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/0/g, "o").replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s").replace(/7/g, "t").replace(/[^a-z]/g, "");
  for (const w of NAME_BLOCK) if (norm.includes(w)) return "Player";
  return s;
}

function buildProfile(key, name) {
  const today = quests.dayIndex(Date.now());
  const prog = store.levelProgress(store.getXp(key));
  const s = store.getStats(key);
  const wins = store.getWins(key);
  const st = store.getStreak(key);
  return {
    name: name || null,
    balance: bal(key, "play"),
    level: prog.level, xp: { into: prog.into, need: prog.need },
    stats: {
      games: s.games, wins, winRate: s.games ? Math.round((wins / s.games) * 100) : 0,
      kills: s.kills, deaths: s.deaths, kd: s.deaths ? +(s.kills / s.deaths).toFixed(2) : s.kills,
      crates: s.crates, pickups: s.pickups,
    },
    streak: { count: st.count, best: st.best },
    quests: buildQuests(key, today),
    characters: characters.unlockState({ games: s.games, kills: s.kills, wins, crates: s.crates, pickups: s.pickups, level: prog.level }),
  };
}

// advance one quest's progress; auto-grant XP + toast on completion. player may be undefined.
function bumpQuest(room, player, id, n = 1) {
  if (!player || !player.verified) return;
  const key = player.key, today = quests.dayIndex(Date.now());
  const def = quests.todaysQuests(today).find(d => d.id === id);
  if (!def) return;                                   // quest not active today
  const q = store.getQuestState(key, today);
  if (q.done[id]) return;
  q.prog[id] = (q.prog[id] || 0) + n;
  if (q.prog[id] >= def.target) {
    q.done[id] = true;
    gainXp(room, key, def.xp);
    if (player.ws && player.ws.readyState === 1)
      player.ws.send(JSON.stringify({ t: "toast", kind: "quest", label: def.label, xp: def.xp }));
  }
  store.setQuestState(key, q);
}

// arena stakes: a death transfers exactly `stake` (capped at the victim's balance)
// from victim to killer; self/environment deaths burn it. Replaces the old
// drop-to-pot/floor economy in training.
function chargeBuyIn(room, p) {
  if (!isWagerGame(room) || p.bot || p.boughtIn) return;
  const cfg = MAPS[room.mapId];
  if (bal(p.key, room.cur) >= cfg.buyIn) {
    setBal(p.key, bal(p.key, room.cur) - cfg.buyIn, p.name, room.cur);
    room.pot += cfg.buyIn;
    p.boughtIn = true; p.paid = cfg.buyIn;
  } else {
    p.boughtIn = false; p.paid = 0; p.alive = false; p.spectating = true; // can't cover it -> sit this game out
  }
}

// Start a wager game: charge every present, solvent human's buy-in into a fresh pot, then play.
// Returns false (stays in the lobby) if fewer than MIN_WAGER_PLAYERS can actually pay.
function startWagerGame(room) {
  const cfg = MAPS[room.mapId];
  const eligible = [...room.players.values()].filter(p => !p.bot && bal(p.key, room.cur) >= cfg.buyIn);
  if (eligible.length < MIN_WAGER_PLAYERS) { room.phase = "waiting"; room.countdownMs = 0; return false; }
  room.pot = 0; room.gameRound = 1; room.roundWins = new Map();
  for (const p of room.players.values()) {
    if (p.bot) continue;
    p.boughtIn = false; p.paid = 0;
    p.spectating = bal(p.key, room.cur) < cfg.buyIn; // can't afford -> spectate this game (not charged)
  }
  for (const p of eligible) chargeBuyIn(room, p); // debits buy-in, sets p.paid, fills the pot
  newRound(room); // fresh grid + spawns; phase -> "playing"; spectators kept dead
  return true;
}

// A wager game collapsed below MIN_WAGER_PLAYERS (someone left). Refund every player still
// present their own buy-in (no rake — no real contest happened); whoever LEFT forfeits theirs.
function abandonWagerGame(room) {
  for (const p of room.players.values()) {
    if (!p.bot && p.paid > 0) { setBal(p.key, bal(p.key, room.cur) + p.paid, p.name, room.cur); p.paid = 0; }
    p.boughtIn = false; p.spectating = false; p.alive = false;
  }
  room.pot = 0; room.roundWins = new Map(); room.winner = "";
  room.phase = "waiting"; room.countdownMs = 0;
  pushEvent(room, { k: "abandon" });
}

function settleDeath(room, victim, killer) {
  victim.streak = 0;
  // practice (solo + bots) or a bot victim: no chips move. bots have no balance,
  // so we never setBal a bot key (which would leak onto the leaderboard).
  if (!isRanked(room) || victim.bot) return;
  if (isWagerGame(room)) {
    const stake = MAPS[room.mapId].deathStake;
    const lost = Math.min(stake, bal(victim.key, room.cur));
    if (lost <= 0) return;
    setBal(victim.key, bal(victim.key, room.cur) - lost, victim.name, room.cur);
    const c = Math.round((victim.x - TILE / 2) / TILE), r = Math.round((victim.y - TILE / 2) / TILE);
    room.drops.push({ c, r, a: lost });
    return;
  }
  const stake = room.deathDrop != null ? room.deathDrop : DEATH_DROP;
  const lost = Math.min(stake, bal(victim.key, room.cur));
  if (lost <= 0) return;
  setBal(victim.key, bal(victim.key, room.cur) - lost, victim.name, room.cur);   // human victim loses the stake
  if (killer && killer.id !== victim.id && killer.alive && !killer.bot)          // only a living human killer collects
    setBal(killer.key, bal(killer.key, room.cur) + lost, killer.name, room.cur);
}

function tick(room, dt) {
  // Wager lobby: wait for >=MIN_WAGER_PLAYERS, then count down, then charge buy-ins and start.
  // Nobody is charged until startWagerGame fires, so sitting alone in the lobby costs nothing.
  if (isWagerGame(room) && (room.phase === "waiting" || room.phase === "countdown")) {
    const humans = humanCount(room);
    if (room.phase === "waiting") {
      if (humans >= MIN_WAGER_PLAYERS) { room.phase = "countdown"; room.countdownMs = humans >= MAX_PLAYERS ? LOBBY_FULL_MS : LOBBY_COUNTDOWN_MS; }
    } else { // countdown
      if (humans < MIN_WAGER_PLAYERS) { room.phase = "waiting"; room.countdownMs = 0; }
      else {
        if (humans >= MAX_PLAYERS && room.countdownMs > LOBBY_FULL_MS) room.countdownMs = LOBBY_FULL_MS; // full -> start soon, don't wait out the window
        room.countdownMs -= dt;
        if (room.countdownMs <= 0) startWagerGame(room);
      }
    }
  }
  if (room.phase === "playing") for (const p of room.players.values()) if (p.bot && p.alive && p.ai) botThink(room, p);
  if (room.phase === "playing") for (const pl of room.players.values()) movePlayer(room, pl);

  // skull curses: count down, and pass on contact (hot-potato)
  if (room.phase === "playing") {
    const alive = [...room.players.values()].filter(p => p.alive);
    for (const pl of alive) {
      if (pl.curseImmune > 0) pl.curseImmune = Math.max(0, pl.curseImmune - dt);
      if (!pl.curse) continue;
      pl.curseT -= dt;
      if (pl.curseT <= 0) { pl.curse = null; pl.curseT = 0; continue; }
    }
    for (const a of alive) {
      if (!a.curse || a.curseImmune > 0) continue;
      for (const b of alive) {
        if (b === a || b.curse || b.curseImmune > 0) continue;
        if (Math.abs(a.x - b.x) < TILE * 0.72 && Math.abs(a.y - b.y) < TILE * 0.72) {
          b.curse = a.curse; b.curseT = a.curseT; b.curseImmune = CURSE_IMMUNE_MS;
          a.curse = null; a.curseT = 0; a.curseImmune = CURSE_IMMUNE_MS;  // giver is cured (hot-potato)
          pushEvent(room, { k: "curse", who: b.name, type: b.curse });
          break;
        }
      }
    }
  }

  for (const b of room.bombs) b.t -= dt;
  const going = room.bombs.filter(b => b.t <= 0);
  if (going.length) {
    room.bombs = room.bombs.filter(b => b.t > 0);
    for (const pl of room.players.values()) for (const b of going) pl.ignore.delete(b.id);
    for (const b of going) explode(room, b);
  }

  for (const f of room.fires) f.t -= dt;
  room.fires = room.fires.filter(f => f.t > 0);

  if (room.fires.length) {
    // worst (highest-damage) fire on each tile
    const fmap = new Map();
    for (const f of room.fires) { const k = f.c + "," + f.r; const ex = fmap.get(k); if (!ex || f.dmg > ex.dmg) fmap.set(k, f); }
    for (const pl of room.players.values()) {
      if (!pl.alive) continue;
      const c = Math.round((pl.x - TILE / 2) / TILE), r = Math.round((pl.y - TILE / 2) / TILE);
      const f = fmap.get(c + "," + r);
      if (!f || pl.hitBlasts.has(f.bid)) continue; // each blast damages a given player at most once
      pl.hitBlasts.add(f.bid);
      const killer = room.players.get(f.owner);
      pl.hp -= f.dmg;
      if (pl.hp > 0) { pushEvent(room, { k: "hurt", who: pl.name, dmg: f.dmg }); continue; }
      pl.hp = 0; pl.alive = false;
      if (isRanked(room) && !pl.bot) store.bumpStat(pl.key, "deaths");
      const by = !killer ? "a bomb" : (killer.id === pl.id ? null : killer.name);
      if (killer && killer.id !== pl.id && killer.alive && !killer.bot) {
        killer.streak = (killer.streak || 0) + 1;
        gainXp(room, killer.key, XP_KILL);
        if (isRanked(room)) { store.bumpStat(killer.key, "kills"); bumpQuest(room, killer, "kills"); }
      }
      pushEvent(room, { k: "kill", who: pl.name, by, self: !!killer && killer.id === pl.id });
      settleDeath(room, pl, killer);
    }
  }

  if (room.phase === "playing") {
    room.elapsed += dt;
    if (room.elapsed >= SUDDEN_AFTER) stepClosing(room, dt);
  }
  maybeEndRound(room);
}

function roundAnte(room) {
  const cfg = MAPS[room.mapId];
  if (!isWagerGame(room) || cfg.ante == null) return;
  for (const p of room.players.values()) {
    if (p.anted) continue;
    if (bal(p.key, room.cur) >= cfg.ante) { setBal(p.key, bal(p.key, room.cur) - cfg.ante, p.name, room.cur); room.pot += cfg.ante; p.anted = true; }
    else { p.anted = false; p.alive = false; } // can't cover the ante -> sits this round out
  }
}

// sweep any uncollected loot drops back into the pot (wager games only)
function sweepLoot(room) {
  if (!isWagerGame(room)) return;
  for (const d of room.drops) room.pot += d.a;
  room.drops = [];
}

// a wager game is best-of GAME_ROUNDS: at game end the player with the most
// round wins takes the pot minus rake (ties split evenly), then a new game begins.
function endGame(room) {
  sweepLoot(room); // defensive: any loot left on the floor goes into the pot
  const cfg = MAPS[room.mapId];
  const rake = Math.round(room.pot * (cfg.rake || 0));
  const prize = Math.max(0, room.pot - rake);
  let max = -1; for (const w of room.roundWins.values()) if (w > max) max = w;
  const winners = [...room.players.values()].filter(p => !p.bot && (room.roundWins.get(p.id) || 0) === max && max > 0);
  if (winners.length && prize > 0) {
    const share = Math.floor(prize / winners.length);
    for (const w of winners) { setBal(w.key, bal(w.key, room.cur) + share, w.name, room.cur); if (store.bumpWin) store.bumpWin(w.key, w.name); }
  }
  room.pot = 0;
  pushEvent(room, { k: "gameover", winners: winners.map(w => w.name), prize });
  // Back to the lobby. The next game only starts (and charges fresh buy-ins) once
  // >=MIN_WAGER_PLAYERS are present again — handled by the waiting/countdown loop in tick().
  for (const p of room.players.values()) { p.boughtIn = false; p.paid = 0; p.spectating = false; p.alive = false; }
  room.phase = "waiting"; room.countdownMs = 0; room.gameRound = 1; room.roundWins = new Map(); room.winner = "";
}

function maybeEndRound(room) {
  if (room.phase !== "playing") return;
  const list = [...room.players.values()];
  if (list.length < 2) return;
  const alive = list.filter(p => p.alive);
  if (alive.length <= 1) {
    room.phase = "roundover";
    if (isRanked(room)) for (const pp of room.players.values()) { store.bumpStat(pp.key, "games"); bumpQuest(room, pp, "games"); }
    const w = alive[0];
    if (w) {
      room.winner = w.name;
      let payout = 0;
      if (isRanked(room) && !w.bot) {            // a bot winner persists nothing (kept off the leaderboard)
        w.wins++;
        if (!isWagerGame(room)) {                // training: round winner takes the pot now
          payout = Math.max(0, room.pot);
          if (payout > 0) setBal(w.key, bal(w.key, room.cur) + payout, w.name, room.cur);
          store.bumpWin(w.key, w.name);
        }
        bumpQuest(room, w, "win");
      }
      if (!w.bot) gainXp(room, w.key, XP_WIN);
      pushEvent(room, { k: "win", who: w.name, pot: payout });
    } else {
      room.winner = "Draw";
      pushEvent(room, { k: "draw" });
    }
    if (isWagerGame(room)) {
      sweepLoot(room); // pull uncollected loot into the pot before resolving the round
      if (w && !w.bot) room.roundWins.set(w.id, (room.roundWins.get(w.id) || 0) + 1);
      if (room.gameRound >= GAME_ROUNDS) endGame(room);
      else room.gameRound++; // existing round-restart flow continues as today
    }
  }
}

function snapshot(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({ id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y),
      b: p.base, s: p.skin, cl: p.clothes, a: p.alive, w: p.wins, bal: bal(p.key, room.cur),
      hp: Math.max(0, Math.round(p.hp)), mh: p.maxHp || MAX_HP, lvl: store.levelFromXp(store.getXp(p.key)),
      st: p.streak || 0,
      sp: effSpeed(p), mb: p.maxBombs, nb: room.bombs.filter(b => b.owner === p.id).length, rg: p.range,
      tp: p.tp ? 1 : 0, cu: p.curse || 0, spec: p.spectating ? 1 : 0 });
    p.tp = false; // one-shot: only the first snapshot after a respawn/teleport tells the client to hard-snap
  }
  return {
    t: "s",
    players,
    bombs: room.bombs.map(b => ({ c: b.col, r: b.row, f: Math.max(0, b.t / FUSE) })),
    fires: room.fires.map(f => ({ c: f.c, r: f.r })),
    ups: room.ups.map(u => ({ c: u.c, r: u.r, k: u.k })),
    drops: room.drops.map(d => ({ c: d.c, r: d.r, a: d.a })),
    pot: room.pot, gr: room.gameRound, gn: GAME_ROUNDS, ev: room.events.slice(),
    ph: room.phase, win: room.winner, sudden: room.sudden,
    cd: room.phase === "countdown" ? Math.max(0, Math.ceil((room.countdownMs || 0) / 1000)) : 0, // lobby countdown (s)
    hu: humanCount(room), need: isWagerGame(room) ? MIN_WAGER_PLAYERS : 0,                        // waiting-room headcount
    warn: room.pendingWalls.map(w => ({ c: w.c, r: w.r })), // tiles about to become walls (client flashes them)
  };
}

// ---- bots: AI helpers + headcount (training rooms only; bots are ephemeral) ----
const BOT_TARGET = 4; // desired total players in a room while a human is present
function humanCount(room) { let n = 0; for (const p of room.players.values()) if (!p.bot) n++; return n; }
function isRanked(room) { return humanCount(room) >= 2; } // <2 humans = practice (XP only)
function botTarget(humans) { return Math.max(0, Math.min(BOT_TARGET - humans, MAX_PLAYERS - humans)); }

function botWalkable(room, c, r) {
  return c >= 0 && r >= 0 && c < room.cols && r < room.rows &&
    room.grid[r][c] === 0 && !room.bombs.some(b => b.col === c && b.row === r);
}
function botBlastCells(room, c, r, range) {
  const s = new Set([c + "," + r]);
  for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    for (let i = 1; i <= range; i++) {
      const nc = c + dc * i, nr = r + dr * i;
      if (nc < 0 || nr < 0 || nc >= room.cols || nr >= room.rows) break;
      const t = room.grid[nr][nc];
      if (t === 1) break;            // wall blocks
      s.add(nc + "," + nr);
      if (t === 2) break;            // crate absorbs the rest
    }
  }
  return s;
}
function botDangerSet(room) {
  const s = new Set();
  for (const b of room.bombs) for (const k of botBlastCells(room, b.col, b.row, b.range)) s.add(k);
  return s;
}
function botThink(room, bot) {
  const c = Math.round((bot.x - TILE/2)/TILE), r = Math.round((bot.y - TILE/2)/TILE);
  const cx = c*TILE + TILE/2, cy = r*TILE + TILE/2;
  const centered = Math.abs(bot.x - cx) < 3 && Math.abs(bot.y - cy) < 3;
  const danger = botDangerSet(room);
  const players = [...room.players.values()];
  if (centered) {
    bot.x = cx; bot.y = cy;
    if (danger.has(c + "," + r)) {
      const safe = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].filter(([nc,nr]) => botWalkable(room,nc,nr) && !danger.has(nc+","+nr));
      bot.ai.tc = safe.length ? safe[0][0] : c; bot.ai.tr = safe.length ? safe[0][1] : r; bot.ai.flee = true;
    } else {
      bot.ai.flee = false;
      const adjCrate = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].some(([nc,nr]) => nr>=0&&nc>=0&&nr<room.rows&&nc<room.cols&&room.grid[nr][nc]===2);
      let ed = 99; for (const q of players){ if (q===bot||!q.alive) continue; const qc=Math.round((q.x-TILE/2)/TILE),qr=Math.round((q.y-TILE/2)/TILE); ed=Math.min(ed,Math.abs(qc-c)+Math.abs(qr-r)); }
      const canBomb = room.bombs.filter(b=>b.owner===bot.id).length < bot.maxBombs && room.grid[r][c]===0 && !room.bombs.some(b=>b.col===c&&b.row===r);
      if (canBomb && (adjCrate || ed <= bot.range+1) && Math.random() < 0.85) {
        const blast = botBlastCells(room, c, r, bot.range);
        const esc = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].find(([nc,nr]) => botWalkable(room,nc,nr) && !blast.has(nc+","+nr));
        if (esc) { placeBomb(room, bot); bot.ai.tc=esc[0]; bot.ai.tr=esc[1]; bot.ai.flee=true; }
        else if (ed <= 1) { placeBomb(room, bot); const any=[[c+1,r],[c-1,r],[c,r+1],[c,r-1]].find(([nc,nr])=>botWalkable(room,nc,nr)); if(any){bot.ai.tc=any[0];bot.ai.tr=any[1];bot.ai.flee=true;}else{bot.ai.tc=c;bot.ai.tr=r;} }
        else { bot.ai.tc=c; bot.ai.tr=r; }
      } else {
        let opts = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].filter(([nc,nr]) => botWalkable(room,nc,nr) && !danger.has(nc+","+nr));
        if (!opts.length) opts = [[c+1,r],[c-1,r],[c,r+1],[c,r-1]].filter(([nc,nr]) => botWalkable(room,nc,nr));
        if (opts.length) {
          let tgt=null,best=1e9; for (const q of players){ if(q===bot||!q.alive)continue; const qc=Math.round((q.x-TILE/2)/TILE),qr=Math.round((q.y-TILE/2)/TILE); const d=Math.abs(qc-c)+Math.abs(qr-r); if(d<best){best=d;tgt=[qc,qr];} }
          if (tgt && Math.random() < 0.8) { opts.sort((a,b)=>(Math.abs(a[0]-tgt[0])+Math.abs(a[1]-tgt[1]))-(Math.abs(b[0]-tgt[0])+Math.abs(b[1]-tgt[1]))); bot.ai.tc=opts[0][0]; bot.ai.tr=opts[0][1]; }
          else { const pick=opts[Math.floor(Math.random()*opts.length)]; bot.ai.tc=pick[0]; bot.ai.tr=pick[1]; }
        } else { bot.ai.tc=c; bot.ai.tr=r; }
      }
    }
  }
  const tx = bot.ai.tc*TILE + TILE/2, ty = bot.ai.tr*TILE + TILE/2;
  bot.in = { l: bot.x > tx+1, r: bot.x < tx-1, u: bot.y > ty+1, d: bot.y < ty-1 };
}

const BOT_NAMES = ["Sparky","Boomer","Dyna","Pixel","Fuse","Blanka","Volt","Nitro","Pop","Tnt"];
const BOT_LOOKS = [["hero","#e8b07a","#ff5d73"],["house","#e8b07a","#54b8ff"],["hero","#e8b07a","#a06bff"],
  ["house","#e8b07a","#43d17f"],["hero","#e8b07a","#ffb03a"],["popcat","#e8b07a","#ff5dd8"],["alon","#e8b07a","#37d6ff"]];
let botSeq = 1000000; // bot ids live well above human nextId
function botName(room){ const used=new Set([...room.players.values()].map(p=>p.name));
  const free=BOT_NAMES.filter(n=>!used.has(n)); const pool=free.length?free:BOT_NAMES; return pool[Math.floor(Math.random()*pool.length)]; }
function makeBot(room){
  const id=botSeq++; const look=BOT_LOOKS[Math.floor(Math.random()*BOT_LOOKS.length)];
  const bot={ id, ws:{readyState:3}, key:"bot:"+id, wallet:null, verified:false, voice:false, bot:true,
    name:botName(room), base:look[0], skin:look[1], clothes:look[2] };
  addPlayer(room, bot); return bot;
}
// fill training rooms to BOT_TARGET while a human is present; fade bots out as humans join.
function syncBots(room){
  if (isWagerGame(room)) return;        // never in wager/real rooms
  const humans = humanCount(room);
  const bots = [...room.players.values()].filter(p=>p.bot);
  if (humans === 0) { for (const b of bots) room.players.delete(b.id); return; } // let the room drop
  const want = botTarget(humans);
  if (bots.length < want) { for (let i=bots.length; i<want; i++) makeBot(room); return; }
  if (bots.length > want) {
    let remove = bots.length - want;
    const dead = bots.filter(b=>!b.alive), live = bots.filter(b=>b.alive);
    for (const b of dead) { if (remove<=0) break; room.players.delete(b.id); remove--; }
    if (room.phase !== "playing") for (const b of live) { if (remove<=0) break; room.players.delete(b.id); remove--; }
  }
}

// send a message to every connected player in a room, skipping bots/closed sockets
// (bots carry a stub ws with no send(), so an unguarded send would crash the loop)
function broadcast(room, obj) {
  const str = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(str);
}

// per-connection token bucket: legit play stays well under `rate`/sec; floods are
// shed (return false). `state` = { tokens, last, over }. Pure (now injected) -> testable.
function rateAllow(state, now, rate = 30, burst = 50) {
  state.tokens = Math.min(burst, state.tokens + (now - state.last) * rate / 1000);
  state.last = now;
  // decay `over` (don't reset) so a time-paced flood still climbs past the close
  // threshold, while a brief legit burst decays harmlessly back to 0.
  if (state.tokens >= 1) { state.tokens -= 1; if (state.over > 0) state.over--; return true; }
  state.over = (state.over || 0) + 1;
  return false;
}

// ---- custody HTTP route bodies (factored out so the disabled gate is unit-testable) ----
// The disabled gate MUST win even before auth: when real-money env isn't set we never
// touch balances or the chain. Auth is verified by the HTTP layer before calling these.
async function handleWithdraw(body) {
  if (!custody.enabled()) return { error: "disabled" };
  if (!body.idemKey) return { error: "idem_required" }; // mandatory: no fabricated key (would defeat idempotency)
  const key = String(body.wallet).slice(0, 64);
  const amount = Number(body.amount);
  return await custody.withdraw({ wallet: key, amount, idemKey: body.idemKey }, store);
}

module.exports = {
  TILE, FUSE, BLAST, START_BAL, DEATH_DROP, SUDDEN_AFTER, CLOSE_EVERY, POT_SHARE, MAX_HP, DMG_CORE, DMG_EDGE, GAME_ROUNDS,
  LOBBY_COUNTDOWN_MS, LOBBY_FULL_MS, MIN_WAGER_PLAYERS, MAX_PLAYERS, BOUNTY_STEP, BOUNTY_MAX, MAPS, balances,
  bal, setBal, genGrid, latticeGrid, generateRoom, connected, spawns, clearSpawns, monument,
  makeRoom, newRound, addPlayer, movePlayer, buildCloseOrder, solidifyTile, stepClosing, dailySeed, roundAnte,
  placeBomb, explode, settleDeath, chargeBuyIn, sweepLoot, endGame, startWagerGame, abandonWagerGame, tick, snapshot, store, auth,
  buildProfile, buildQuests, bumpQuest, characters,
  humanCount, isRanked, isWagerGame, botTarget, botWalkable, botBlastCells, botDangerSet,
  makeBot, syncBots, broadcast, rateAllow, custody, handleWithdraw,
};

// ---------- live server (exported so tests can start it on an ephemeral port) ----------
function startServer(port) {
  const http = require("http");
  const fs = require("fs");
  const path = require("path");
  const { WebSocketServer } = require("ws");

  const roomsByKey = new Map(); // "mode:mapId" -> [room, room, ...]
  function roomFor(mapId, mode) {
    const id = MAPS[mapId] ? mapId : DEFAULT_MAP;
    const m = mode === "real" ? "real" : "play";
    const key = m + ":" + id;
    let list = roomsByKey.get(key);
    if (!list) { list = []; roomsByKey.set(key, list); }
    let room = list.find(r => r.players.size < MAX_PLAYERS);
    if (!room) { room = makeRoom(id, m); list.push(room); }
    return room;
  }
  function allRooms() {
    const out = [];
    for (const list of roomsByKey.values()) for (const r of list) out.push(r);
    return out;
  }
  function dropRoom(room) {
    const list = roomsByKey.get(room.mode + ":" + room.mapId);
    if (!list) return;
    const i = list.indexOf(room);
    if (i >= 0) list.splice(i, 1);
  }
  let nextId = 1;

  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".svg": "image/svg+xml" };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url || "").split("?")[0] === "/profile") {
      let body = "", aborted = false;
      req.on("data", (c) => {
        if (aborted) return;
        body += c;
        if (body.length > 4096) { // reply cleanly instead of RST-ing the client
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (aborted) return;
        try {
          const m = JSON.parse(body || "{}");
          if (!(m.wallet && m.auth && auth.verify(m.wallet, m.auth.ts, m.auth.sig))) {
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "unauthorized" }));
          }
          const key = String(m.wallet).slice(0, 64);
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(buildProfile(key, store.getName(key))));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad_request" }));
        }
      });
      return;
    }
    // ---- custody routes (real-money). All gated: when custody.enabled() is false
    // they short-circuit to {error:"disabled"} and never touch balances/the chain. ----
    {
      const cpath = (req.url || "").split("?")[0];
      const CUSTODY_ROUTES = new Set(["/wallet", "/deposit-info", "/withdraw"]);
      if (req.method === "POST" && CUSTODY_ROUTES.has(cpath)) {
        let body = "", aborted = false;
        req.on("data", (c) => {
          if (aborted) return;
          body += c;
          if (body.length > 4096) {
            aborted = true;
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payload_too_large" }));
            req.destroy();
          }
        });
        req.on("end", async () => {
          if (aborted) return;
          const reply = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(obj));
          };
          try {
            const m = JSON.parse(body || "{}");
            // /deposit-info: no auth needed (public treasury + mint), but still gated.
            if (cpath === "/deposit-info") {
              if (!custody.enabled()) return reply(200, { error: "disabled" });
              const web3 = require("@solana/web3.js");
              const bs58 = require("bs58").default || require("bs58");
              const treasuryKp = web3.Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_SECRET));
              return reply(200, { treasury: treasuryKp.publicKey.toBase58(), mint: process.env.KABOOM_MINT });
            }
            // /wallet and /withdraw are auth-verified.
            if (!(m.wallet && m.auth && auth.verify(m.wallet, m.auth.ts, m.auth.sig))) {
              return reply(401, { error: "unauthorized" });
            }
            const key = String(m.wallet).slice(0, 64);
            if (cpath === "/wallet") {
              if (!custody.enabled()) return reply(200, { error: "disabled" });
              return reply(200, { balance: store.getBalance(key, 0, "real"), ledger: store.getLedger(key) });
            }
            if (cpath === "/withdraw") {
              const out = await handleWithdraw({ wallet: key, amount: m.amount, idemKey: m.idemKey });
              return reply(200, out);
            }
          } catch (e) {
            return reply(400, { error: "bad_request" });
          }
        });
        return;
      }
    }
    let url = req.url.split("?")[0];
    if (url === "/") url = "/index.html";
    if (url === "/health") { res.writeHead(200); return res.end("ok"); }
    if (url === "/lobby") {
      const maps = Object.keys(MAPS).map(id => {
        const list = [...(roomsByKey.get("play:" + id) || []), ...(roomsByKey.get("real:" + id) || [])];
        const players = list.reduce((a, r) => a + r.players.size, 0);
        return { id, name: MAPS[id].name, cols: MAPS[id].cols, rows: MAPS[id].rows, drop: MAPS[id].deathDrop,
          buyIn: MAPS[id].buyIn != null ? MAPS[id].buyIn : null,
          deathStake: MAPS[id].deathStake != null ? MAPS[id].deathStake : null,
          players, rooms: list.length, cap: MAX_PLAYERS, daily: !!MAPS[id].daily,
          seed: MAPS[id].daily ? dailySeed() : null };
      });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ maps, realMoney: REAL_MONEY_ENABLED, scores: store.topScores(10) }));
    }
    if (url === "/scores") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ scores: store.topScores(20) }));
    }
    if (url === "/characters") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ default: characters.DEFAULT_BASE, reqs: characters.CHARACTER_REQS }));
    }
    const file = path.join(__dirname, "public", path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, maxPayload: 16384 }); // cap payloads (blocks memory bombs; fits SDP)
  wss.on("connection", (ws) => {
    let player = null, room = null;
    const rl = { tokens: 50, last: Date.now(), over: 0 }; // per-connection rate bucket
    let joins = 0;
    ws.on("message", (raw) => {
      if (!rateAllow(rl, Date.now())) { if (rl.over > 200) { try { ws.close(1008, "rate"); } catch (e) {} } return; } // shed floods
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === "join") {
        if (player) return;        // one successful join per connection (no player-leak / re-key)
        if (++joins > 15) return;  // cap auth.verify attempts per connection
        const mapId = MAPS[m.map] ? m.map : DEFAULT_MAP;
        const mode = (m.mode === "real") ? "real" : "play";
        // signed-login: only key by a wallet the player proved they own
        const verified = !!(m.wallet && m.auth && auth.verify(m.wallet, m.auth.ts, m.auth.sig));
        if (mode === "real") {
          // real money is gated until the $KABOOM token + treasury are configured,
          // and always requires a verified wallet (never guests)
          if (!REAL_MONEY_ENABLED) { ws.send(JSON.stringify({ t: "blocked", reason: "real_soon" })); return; }
          if (!verified) { ws.send(JSON.stringify({ t: "blocked", reason: "need_wallet" })); return; }
          // wager join gate: must be able to cover the buy-in plus at least one death stake
          const wcfg = MAPS[mapId];
          if (wcfg && wcfg.wager) {
            const wkey = String(m.wallet).slice(0, 64);
            if (bal(wkey, "real") < (wcfg.buyIn + wcfg.deathStake)) {
              ws.send(JSON.stringify({ t: "blocked", reason: "insufficient" })); return;
            }
          }
        }
        room = roomFor(mapId, mode);
        const id = nextId++;
        const key = verified ? String(m.wallet).slice(0, 64) : ("guest:" + id);
        const ustats = verified ? { ...store.getStats(key), wins: store.getWins(key), level: store.levelFromXp(store.getXp(key)) } : {};
        const allowedBase = characters.isUnlocked(m.base, ustats) ? m.base : characters.DEFAULT_BASE;
        player = {
          id, ws, key, wallet: verified ? m.wallet : null, verified, voice: false,
          name: cleanName(m.name),
          base: allowedBase, skin: m.skin || "#e8b07a", clothes: m.clothes || "#7d8aa0",
        };
        addPlayer(room, player);
        syncBots(room);
        // wager: NEVER charge on join. If a game is already in progress, the newcomer spectates
        // until the next game; otherwise they sit in the lobby and get charged when it starts.
        if (isWagerGame(room) && (room.phase === "playing" || room.phase === "roundover")) { player.spectating = true; player.alive = false; }
        const today = quests.dayIndex(Date.now());
        let streakResult = null;
        if (player.verified) {
          const st = quests.nextStreak(store.getStreak(key), today);
          store.setStreak(key, { count: st.count, best: st.best, day: st.day });
          if (st.xpAwarded > 0) gainXp(room, key, st.xpAwarded);
          streakResult = { count: st.count, xpAwarded: st.xpAwarded };
        }
        ws.send(JSON.stringify({
          t: "init", id, map: room.mapId, mode: room.mode, COLS: room.cols, ROWS: room.rows, TILE,
          W: room.W, H: room.H, fuse: FUSE, grid: room.grid, bal: bal(key, room.cur), seed: room.seed,
          verified, pot: room.pot, drop: room.deathDrop,
          wager: isWagerGame(room), ante: MAPS[room.mapId].ante || 0, rake: MAPS[room.mapId].rake || 0,
          quests: player.verified ? buildQuests(key, today) : null,
          streak: streakResult,
        }));
      } else if (!player || !room) {
        return;
      } else if (m.t === "in") {
        player.in = { u: !!m.u, d: !!m.d, l: !!m.l, r: !!m.r };
      } else if (m.t === "bomb") {
        placeBomb(room, player);
      } else if (m.t === "emote") {
        const e = String(m.e || "").slice(0, 4);
        if (e) pushEvent(room, { k: "emote", id: player.id, who: player.name, e });
      } else if (m.t === "voice-on") {
        player.voice = true;
        const peers = [...room.players.values()].filter(p => p.voice && p.id !== player.id).map(p => p.id);
        ws.send(JSON.stringify({ t: "voice-peers", peers })); // newcomer initiates to these
        for (const p of room.players.values())
          if (p.voice && p.id !== player.id && p.ws.readyState === 1)
            p.ws.send(JSON.stringify({ t: "voice-peer-joined", id: player.id }));
      } else if (m.t === "voice-off") {
        player.voice = false;
        for (const p of room.players.values())
          if (p.id !== player.id && p.ws.readyState === 1)
            p.ws.send(JSON.stringify({ t: "voice-peer-left", id: player.id }));
      } else if (m.t === "rtc") {
        const dst = room.players.get(m.to); // relay SDP/ICE only to the named peer in this room
        if (dst && dst.voice && dst.ws.readyState === 1)
          dst.ws.send(JSON.stringify({ t: "rtc", from: player.id, data: m.data }));
      }
    });
    ws.on("close", () => {
      if (room && player) {
        if (player.voice)
          for (const p of room.players.values())
            if (p.id !== player.id && p.ws.readyState === 1)
              p.ws.send(JSON.stringify({ t: "voice-peer-left", id: player.id }));
        room.players.delete(player.id);
        syncBots(room);
        // wager: if leaving drops a live game below the minimum, abandon it and refund whoever's
        // still here their buy-in (the player who left forfeits theirs).
        if (isWagerGame(room) && (room.phase === "playing" || room.phase === "roundover")) {
          const chargedPresent = [...room.players.values()].filter(p => !p.bot && p.paid > 0).length;
          if (chargedPresent < MIN_WAGER_PLAYERS) { clearTimeout(room.roundTimer); room.roundTimer = null; abandonWagerGame(room); }
        }
        if (humanCount(room) === 0) { clearTimeout(room.roundTimer); for (const b of [...room.players.values()]) room.players.delete(b.id); dropRoom(room); }
      }
    });
  });

  // Drift-compensated sim loop: advance each room by however many fixed TICK steps real
  // wall-clock time actually elapsed (carrying the sub-tick remainder), capped to avoid a
  // spiral after a long GC/pause. Keeps the true 60/s sim rate under event-loop jitter, so
  // clients (which predict in real time) don't drift ahead of the server and get yanked back.
  let _lastTick = Date.now(), _acc = 0;
  const tickTimer = setInterval(() => {
    const now = Date.now();
    _acc += now - _lastTick; _lastTick = now;
    if (_acc > 250) _acc = 250;                 // cap catch-up (~15 steps) — never spiral
    let steps = 0;
    while (_acc >= TICK && steps < 15) {
      for (const room of allRooms()) tick(room, TICK);
      _acc -= TICK; steps++;
    }
    for (const room of allRooms()) {
      if (room.phase === "roundover" && !room.roundTimer) {
        room.roundTimer = setTimeout(() => { room.roundTimer = null; newRound(room);
          broadcast(room, { t: "round", grid: room.grid, win: "", seed: room.seed });
        }, 4200);
      }
    }
  }, TICK);

  const snapTimer = setInterval(() => {
    for (const room of allRooms()) {
      const snap = snapshot(room);
      if (room.destroyed.length) { snap.d = room.destroyed.slice(); room.destroyed.length = 0; }
      if (room.walls.length) { snap.walls = room.walls.slice(); room.walls.length = 0; }
      const str = JSON.stringify(snap);
      for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(str);
      room.events.length = 0;
    }
  }, SNAP);

  // don't let the game-loop timers keep the process alive on their own; the
  // listening socket holds the event loop open while serving. this lets a test
  // that calls server.close() exit cleanly instead of hanging on the intervals.
  if (tickTimer.unref) tickTimer.unref();
  if (snapTimer.unref) snapTimer.unref();

  // Start the on-chain deposit watcher. INERT unless real-money is enabled (all 3 env vars) —
  // then it polls the treasury and auto-credits inbound $KABOOM deposits to player balances.
  // Without this, deposits would never be detected. Guarded so a watcher init error can't crash boot.
  try { const watchTimer = custody.startWatcher(store); if (watchTimer && watchTimer.unref) watchTimer.unref(); }
  catch (e) { console.error("deposit watcher failed to start:", e); }

  server.listen(port, () => console.log("KABOOMIES server on :" + port));
  return server;
}
module.exports.startServer = startServer;

// run only when executed directly (keeps the module importable for tests)
if (require.main === module) {
  store.init();
  startServer(process.env.PORT || 3000);
}
