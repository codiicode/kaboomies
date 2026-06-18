const test = require("node:test");
const assert = require("node:assert");
const os = require("os"), path = require("path"), fs = require("fs");
const WebSocket = require("ws");
process.env.KABOOM_DATA = path.join(os.tmpdir(), "kaboomies-botslive-" + process.pid + ".json");
const game = require("../server");
test.after(() => { try { fs.unlinkSync(process.env.KABOOM_DATA); } catch (e) {} });

test("a solo human joining a training room gets bots and a live round", async () => {
  const server = game.startServer(0);
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const ws = new WebSocket("ws://127.0.0.1:" + port);
  const seen = { max: 0, playing: false };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name: "Solo", base: "hero", skin: "#e8b07a", clothes: "#fff", map: "brawl", mode: "play" })));
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.t === "s") { seen.max = Math.max(seen.max, m.players.length); if (m.ph === "playing") seen.playing = true; }
  });
  await new Promise(r => setTimeout(r, 2500));
  ws.close();
  await new Promise(r => server.close(r));
  assert.ok(seen.max >= 2, "expected bots to fill the room, saw max " + seen.max + " players");
  assert.ok(seen.playing, "expected the round to be playing");
});
