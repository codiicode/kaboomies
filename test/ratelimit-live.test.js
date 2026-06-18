const test = require("node:test");
const assert = require("node:assert");
const os = require("os"), path = require("path"), fs = require("fs");
const WebSocket = require("ws");
process.env.KABOOM_DATA = path.join(os.tmpdir(), "kaboomies-rl-" + process.pid + ".json");
const game = require("../server");
test.after(() => { try { fs.unlinkSync(process.env.KABOOM_DATA); } catch (e) {} });

function open(port) {
  return new Promise(r => { const ws = new WebSocket("ws://127.0.0.1:" + port); ws.on("open", () => r(ws)); });
}

test("malformed join name doesn't crash; a flood doesn't take down other clients", async () => {
  const server = game.startServer(0);
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;

  // A: malformed name (number) — must not crash the server; should still get an init.
  const a = await open(port);
  let aInit = false;
  a.on("message", raw => { try { if (JSON.parse(raw).t === "init") aInit = true; } catch (e) {} });
  a.send(JSON.stringify({ t: "join", name: 12345, base: "hero", skin: "#e8b07a", clothes: "#fff", map: "brawl", mode: "play" }));
  await new Promise(r => setTimeout(r, 300));

  // A floods the server with rapid messages.
  for (let i = 0; i < 800; i++) a.send(JSON.stringify({ t: "in", u: true }));

  // B is a normal client that joins during the flood — must still receive snapshots (server alive).
  const b = await open(port);
  let bSnaps = 0;
  b.on("message", raw => { try { if (JSON.parse(raw).t === "s") bSnaps++; } catch (e) {} });
  b.send(JSON.stringify({ t: "join", name: "Normal", base: "hero", skin: "#e8b07a", clothes: "#fff", map: "brawl", mode: "play" }));

  await new Promise(r => setTimeout(r, 1500));
  try { a.close(); } catch (e) {}
  try { b.close(); } catch (e) {}
  await new Promise(r => server.close(r));

  assert.ok(aInit, "client A with a numeric name should still get an init (name coerced, no crash)");
  assert.ok(bSnaps >= 1, "a normal client should keep receiving snapshots despite A's flood (server alive)");
});
