const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

const TMP = path.join(os.tmpdir(), "kaboomies-profile-test-" + process.pid + ".json");
process.env.KABOOM_DATA = TMP;
const game = require("../server");
const store = game.store;

test.after(() => { try { fs.unlinkSync(TMP); } catch (e) {} });

test("buildProfile returns level, stats, streak and 3 quests", () => {
  store.bumpStat("walletP", "kills", 7);
  store.bumpStat("walletP", "deaths", 2);
  store.bumpStat("walletP", "games", 4);
  store.bumpWin("walletP", "Pat");
  const p = game.buildProfile("walletP", "Pat");
  assert.strictEqual(p.stats.kills, 7);
  assert.strictEqual(p.stats.deaths, 2);
  assert.strictEqual(p.stats.games, 4);
  assert.strictEqual(p.stats.wins, 1);
  assert.strictEqual(p.stats.winRate, 25);          // 1/4
  assert.strictEqual(p.stats.kd, 3.5);              // 7/2
  assert.ok(p.level >= 1);
  assert.strictEqual(p.quests.length, 3);
  assert.ok("count" in p.streak && "best" in p.streak);
});

test("buildProfile K/D with zero deaths equals kills", () => {
  store.bumpStat("walletQ", "kills", 5);
  const p = game.buildProfile("walletQ", null);
  assert.strictEqual(p.stats.kd, 5);
});

const http = require("http");
const nacl = require("tweetnacl");
const bs58 = require("bs58").default || require("bs58");

function signedBody() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(Buffer.from(kp.publicKey));
  const ts = Date.now();
  const msg = new TextEncoder().encode(`KABOOMIES login\nwallet: ${wallet}\nts: ${ts}`);
  const sig = Array.from(nacl.sign.detached(msg, kp.secretKey));
  return { wallet, auth: { ts, sig } };
}

test("POST /profile returns a profile for a valid signature, 401 otherwise", async () => {
  const server = game.startServer(0);                 // ephemeral port
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;

  const post = (obj) => new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const req = http.request({ host: "127.0.0.1", port, path: "/profile", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", reject);
    req.end(data);
  });

  try {
    const ok = await post(signedBody());
    assert.strictEqual(ok.status, 200);
    const prof = JSON.parse(ok.body);
    assert.strictEqual(prof.quests.length, 3);
    assert.ok(prof.level >= 1);

    const bad = await post({ wallet: "nope", auth: { ts: Date.now(), sig: [1, 2, 3] } });
    assert.strictEqual(bad.status, 401);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("buildProfile includes the 9-character unlock state (hero + earl starters)", () => {
  const p = game.buildProfile("walletChars", "Cee");
  assert.strictEqual(p.characters.length, 9);
  assert.strictEqual(p.characters[0].base, "hero");
  assert.strictEqual(p.characters[0].unlocked, true);
  assert.strictEqual(p.characters[1].base, "earl");
  assert.strictEqual(p.characters[1].unlocked, true);
});

test("GET /characters returns the requirement defs (no auth)", async () => {
  const server = game.startServer(0);
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/characters", method: "GET" },
      (res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b) })); });
    req.on("error", reject); req.end();
  });
  try {
    assert.strictEqual(body.status, 200);
    assert.strictEqual(body.json.default, "hero");
    assert.ok(Array.isArray(body.json.reqs) && body.json.reqs.length === 7);
    assert.ok(body.json.reqs.every(r => r.base && r.label && typeof r.target === "number"));
  } finally { await new Promise(r => server.close(r)); }
});
