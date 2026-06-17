/* Live integration test: rooms, tokens, lobby, scores, emotes/events, seed. */
const { spawn } = require("child_process");
const WebSocket = require("ws");
const PORT = 3990;
const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(PORT), KABOOM_DATA: "/tmp/kb_live.json" }, cwd: __dirname });
srv.stderr.on("data", d => process.stderr.write("[srv] " + d));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m); } };

function mk(map, wallet, name, mode) {
  const ws = new WebSocket("ws://localhost:" + PORT);
  const st = { ws, init: null, snaps: 0, last: null, evs: [], blocked: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, base: "house", skin: "#e8b07a", clothes: "#7d8aa0", map, wallet, mode })));
  ws.on("message", raw => { const m = JSON.parse(raw);
    if (m.t === "init") st.init = m;
    else if (m.t === "blocked") st.blocked = m.reason;
    else if (m.t === "s") { st.snaps++; st.last = m; if (m.ev && m.ev.length) st.evs.push(...m.ev); } });
  return st;
}

setTimeout(async () => {
  const A = mk("brawl", "WALLET_AAA", "Aaa");
  const B = mk("brawl", "WALLET_BBB", "Bbb");
  const C = mk("highroller", "WALLET_CCC", "Ccc");
  const D = mk("brawl", "WALLET_DDD", "Ddd", "real");
  setTimeout(() => A.ws.send(JSON.stringify({ t: "emote", e: "😀" })), 700);

  setTimeout(async () => {
    ok(A.init && A.init.map === "brawl", "A joined brawl");
    ok(A.init && A.init.COLS === 35 && A.init.ROWS === 18, "brawl dims 35x18");
    ok(A.init && A.init.bal === 1000, "A starting balance 1000");
    ok(typeof (A.init && A.init.seed) === "number", "init carries AI arena seed");
    ok(typeof (A.init && A.init.pot) === "number", "init carries pot");
    ok(A.last && A.last.players.length === 2, "brawl room shows 2 players");
    ok(C.last && C.last.players.length === 1, "high roller room isolated");
    ok(D.blocked === "real_soon" && !D.init, "real-money join blocked until token launches");
    ok(A.last && Array.isArray(A.last.ev), "snapshot has events channel");
    ok(A.evs.some(e => e.k === "emote" && e.e === "😀"), "emote broadcast as event");
    ok(A.last && A.last.players[0].hp === 100 && A.last.players[0].mh === 100, "snapshot carries 100 HP / maxHP");
    ok(A.last && A.last.players.every(p => p.lvl >= 1), "snapshot carries account level");
    const store = require("./store.js");
    ok(store.levelFromXp(0) === 1 && store.levelFromXp(100) === 2 && store.levelFromXp(260) === 3, "level curve 1 -> 2 (100xp) -> 3 (260xp)");

    // lobby endpoint
    try {
      const lob = await (await fetch("http://localhost:" + PORT + "/lobby")).json();
      const grid = lob.maps.find(m => m.id === "brawl");
      ok(grid && grid.players === 2, "lobby reports 2 players on brawl (got " + (grid && grid.players) + ")");
      ok(lob.maps.some(m => m.id === "highroller" && m.drop === 1000), "lobby lists High Roller (1000 drop)");
      ok(lob.maps.some(m => m.id === "casual" && m.drop === 10), "lobby lists Rookie Ring (10 drop)");
      ok(lob.realMoney === false, "lobby reports real-money disabled (no token/treasury yet)");
      ok(Array.isArray(lob.scores), "lobby includes global scores");
    } catch (e) { ok(false, "lobby endpoint reachable (" + e.message + ")"); }

    try {
      const sc = await (await fetch("http://localhost:" + PORT + "/scores")).json();
      ok(Array.isArray(sc.scores), "scores endpoint returns a list");
    } catch (e) { ok(false, "scores endpoint reachable"); }

    console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
    A.ws.close(); B.ws.close(); C.ws.close(); D.ws.close(); srv.kill();
    process.exit(fail ? 1 : 0);
  }, 1600);
}, 700);
