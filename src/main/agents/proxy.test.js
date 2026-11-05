"use strict";

// The agents' road through the app's proxy, on loopback: a local target, a CONNECT proxy and a SOCKS5 relay stand in
// for Polymarket and the proxy, and nothing leaves the machine. Polymarket's host matcher is swapped for the loopback
// names. Then the lanes on fake sockets, and the LP universe's paging.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const WebSocket = require("ws");
const { createProxyRoute, chromiumProxy, POLYMARKET } = require("./proxy");
const { createNet } = require("./net");
const L = require("./lanes");
const { AgentDesk } = require("./desk");

const HOSTS = /^(127\.0\.0\.1|localhost)$/;
const sockets = new Set();
const track = (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); return s; };
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const codeOf = async (promise) => { try { await promise; return "resolved"; } catch (error) { return error.code || error.message; } };
const turn = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const roots = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-proxy-")); roots.push(dir); return dir; };

// The target: JSON in gzip, brotli or plain, an echo, a bomb, a stall and error statuses; it counts its connections.
function target() {
  const hits = { conns: 0, reqs: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.reqs.push({ method: req.method, url: req.url, enc: req.headers["accept-encoding"], ua: req.headers["user-agent"] });
      const send = (status, buf, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(buf); };
      if (req.url === "/gzip") return send(200, zlib.gzipSync(JSON.stringify({ ok: true, via: "gzip" })), { "content-encoding": "gzip" });
      if (req.url === "/br") return send(200, zlib.brotliCompressSync(JSON.stringify({ ok: true, via: "br" })), { "content-encoding": "br" });
      if (req.url === "/plain") return send(200, JSON.stringify({ ok: true, via: "plain" }));
      if (req.url === "/echo") return send(200, JSON.stringify({ method: req.method, type: req.headers["content-type"], body: JSON.parse(body || "null") }));
      if (req.url === "/bomb") return send(200, zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 32)), { "content-encoding": "gzip" });
      if (req.url === "/stall") return undefined;
      const st = /^\/status\/(\d+)$/.exec(req.url);
      return st ? send(+st[1], JSON.stringify({ error: "x" })) : send(404, "{}");
    });
  });
  server.on("connection", (s) => { hits.conns += 1; track(s); });
  return { server, hits };
}

// An HTTP CONNECT proxy, with or without a Basic login; it logs each tunnel it is asked for.
function connectProxy({ auth = null } = {}) {
  const log = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on("connection", track);
  server.on("connect", (req, client, head) => {
    track(client);
    const got = req.headers["proxy-authorization"] || "";
    log.push({ target: req.url, auth: got });
    if (auth && got !== `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const [host, port] = req.url.split(":");
    const up = track(net.connect(+port, host === "localhost" ? "127.0.0.1" : host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    }));
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  return { server, log };
}

// A SOCKS5 relay (RFC 1928/1929); refuseNames answers a host name with "connection refused", as some proxies do.
function socksRelay({ refuseNames = false, auth = null } = {}) {
  const seen = [];
  const server = net.createServer((sock) => {
    track(sock);
    sock.once("data", (hello) => {
      const methods = [...hello.slice(2, 2 + hello[1])];
      if (auth && !methods.includes(2)) return sock.end(Buffer.from([5, 0xff]));
      sock.write(Buffer.from([5, auth ? 2 : 0]));
      const onRequest = (req) => {
        sock.pause();
        const atyp = req[3];
        let host = "ipv6", port = 0;
        if (atyp === 1) { host = [...req.slice(4, 8)].join("."); port = req.readUInt16BE(8); }
        else if (atyp === 3) { const n = req[4]; host = req.slice(5, 5 + n).toString(); port = req.readUInt16BE(5 + n); }
        seen.push({ atyp, host });
        if (atyp === 4 || (refuseNames && atyp === 3)) return sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        const up = track(net.connect(port, host === "localhost" ? "127.0.0.1" : host, () => {
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          up.pipe(sock);
          sock.pipe(up);
        }));
        up.on("error", () => sock.destroy());
        return undefined;
      };
      if (!auth) return sock.once("data", onRequest);
      return sock.once("data", (cred) => {
        const ulen = cred[1];
        const good = cred.slice(2, 2 + ulen).toString() === auth.user && cred.slice(3 + ulen, 3 + ulen + cred[2 + ulen]).toString() === auth.pass;
        sock.write(Buffer.from([1, good ? 0 : 1]));
        if (!good) return sock.end();
        return sock.once("data", onRequest);
      });
    });
  });
  return { server, seen };
}

// A WebSocket that records how it was opened.
class FakeWS {
  constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; FakeWS.all.push(this); setImmediate(() => this.onopen && this.onopen()); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; if (this.onclose) this.onclose(); }
}
FakeWS.all = [];

async function main() {
  const T = target(), tport = await listen(T.server);
  const P = connectProxy(), pport = await listen(P.server);
  const PA = connectProxy({ auth: { user: "u", pass: "p@ss" } }), paport = await listen(PA.server);
  const S = socksRelay(), sport = await listen(S.server);
  const SR = socksRelay({ refuseNames: true }), srport = await listen(SR.server);
  const SA = socksRelay({ auth: { user: "u", pass: "pw" } }), saport = await listen(SA.server);
  const wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.on("listening", resolve));
  const wport = wss.address().port;
  let wsConns = 0;
  wss.on("connection", (ws) => { wsConns += 1; ws.on("message", (m) => ws.send(`echo:${m}`)); });
  const dead = net.createServer(), dport = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));   // a port with nothing on it
  const url = (p, host = "127.0.0.1") => `http://${host}:${tport}${p}`;

  // --- no proxy: nothing is covered, sockets go direct --------------------------------------------------------------
  {
    const route = createProxyRoute(() => "", { hosts: HOSTS });
    assert.deepStrictEqual([route.covers(url("/plain")), route.ws(`ws://127.0.0.1:${wport}`), route.describe().on], [false, undefined, false]);
    assert.ok(POLYMARKET.test("clob.polymarket.com") && POLYMARKET.test("ws-live-data.polymarket.com") && !POLYMARKET.test("polymarket.com.evil.io") && !POLYMARKET.test("api.binance.com"));
  }

  // --- an HTTP proxy: Polymarket through it, the rest direct; one tunnel kept for the polls ---------------------------
  {
    const fetched = [];
    const fetchImpl = async (u) => { fetched.push(u); return new Response(JSON.stringify({ direct: true }), { status: 200 }); };
    const route = createProxyRoute(() => `127.0.0.1:${pport}`, { hosts: HOSTS });   // no scheme: read as http://
    const n = createNet({ fetchImpl, proxy: route });
    assert.deepStrictEqual(await n.json(url("/gzip")), { ok: true, via: "gzip" });
    assert.deepStrictEqual(await n.json(url("/br")), { ok: true, via: "br" });
    assert.deepStrictEqual(await n.json(url("/echo"), { method: "POST", body: [{ token_id: "1" }] }), { method: "POST", type: "application/json", body: [{ token_id: "1" }] });
    assert.deepStrictEqual(await n.json("http://direct.example/x"), { direct: true });
    assert.deepStrictEqual(fetched, ["http://direct.example/x"], "only the uncovered host is fetched directly");
    assert.deepStrictEqual(P.log.map((x) => x.target), [`127.0.0.1:${tport}`], "one tunnel for three requests");
    const last = T.hits.reqs[T.hits.reqs.length - 1];
    assert.ok(/^Vespera\//.test(last.ua) && last.enc === "gzip, br", "compressed answers are asked for");
    assert.strictEqual(await codeOf(n.json(url("/status/429"))), "agents_rate_limited");
    assert.strictEqual(await codeOf(n.json(url("/status/503"))), "agents_http_503");
    assert.strictEqual(await codeOf(n.json(url("/bomb"), { maxBytes: 65536 })), "agents_response_too_large", "the cap counts unpacked bytes");
    assert.strictEqual(await codeOf(n.json(url("/stall"), { timeout: 300 })), "agents_timeout");
    assert.deepStrictEqual(await n.json(url("/plain")), { ok: true, via: "plain" }, "the route still works after a timeout");
    assert.deepStrictEqual(route.describe(), { on: true, url: `http://127.0.0.1:${pport}`, route: null, error: null });
    // a WebSocket through the same proxy
    const before = P.log.length;
    const ws = new WebSocket(`ws://127.0.0.1:${wport}/ws/market`, route.ws(`ws://127.0.0.1:${wport}/ws/market`));
    const echo = await new Promise((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    ws.close();
    assert.deepStrictEqual([echo, P.log.length - before, P.log[P.log.length - 1].target, wsConns], ["echo:hi", 1, `127.0.0.1:${wport}`, 1]);
    route.close();
  }

  // --- the proxy's login ---------------------------------------------------------------------------------------------
  {
    let creds = "u:wrong";
    const route = createProxyRoute(() => `http://${creds}@127.0.0.1:${paport}`, { hosts: HOSTS });
    const n = createNet({ fetchImpl: async () => { throw new Error("direct"); }, proxy: route });
    assert.strictEqual(await codeOf(n.json(url("/plain"))), "agents_proxy_auth");
    assert.deepStrictEqual([route.describe().error, route.describe().url], ["agents_proxy_auth", `http://***@127.0.0.1:${paport}`]);
    creds = "u:p%40ss";   // an address edited in the API panel applies to the next request
    assert.deepStrictEqual(await n.json(url("/plain")), { ok: true, via: "plain" });
    assert.strictEqual(route.describe().error, null);
    assert.strictEqual(PA.log[PA.log.length - 1].auth, `Basic ${Buffer.from("u:p@ss").toString("base64")}`);
    route.close();
  }

  // --- a dead or broken proxy: an error, never a direct call ---------------------------------------------------------
  {
    const fetched = [];
    const fetchImpl = async (u) => { fetched.push(u); return new Response("{}", { status: 200 }); };
    const conns = T.hits.conns, wsBefore = wsConns;
    const down = createProxyRoute(() => `http://127.0.0.1:${dport}`, { hosts: HOSTS });
    assert.strictEqual(await codeOf(createNet({ fetchImpl, proxy: down }).json(url("/plain"))), "agents_proxy_down");
    const sock = new WebSocket(`ws://127.0.0.1:${wport}`, down.ws(`ws://127.0.0.1:${wport}`));
    await new Promise((resolve) => { sock.on("error", (e) => { down.wsError(e); resolve(); }); });
    assert.strictEqual(down.describe().error, "agents_proxy_down");
    const bad = createProxyRoute(() => `ftp://127.0.0.1:${pport}`, { hosts: HOSTS });
    assert.strictEqual(await codeOf(createNet({ fetchImpl, proxy: bad }).json(url("/plain"))), "agents_proxy_invalid");
    assert.throws(() => bad.ws(`ws://127.0.0.1:${wport}`), (e) => e.code === "agents_proxy_invalid");
    assert.deepStrictEqual(bad.describe(), { on: true, url: `ftp://127.0.0.1:${pport}`, route: null, error: "agents_proxy_invalid" });
    await turn(20);
    assert.deepStrictEqual([fetched, T.hits.conns - conns, wsConns - wsBefore], [[], 0, 0], "nothing went direct");
  }

  // --- SOCKS5: the name to the proxy first, IPv4 when it is refused, and the working route kept -----------------------
  {
    const route = createProxyRoute(() => `socks5://127.0.0.1:${sport}`, { hosts: HOSTS });
    assert.deepStrictEqual(JSON.parse(await route.request(url("/plain", "localhost"))), { ok: true, via: "plain" });
    assert.deepStrictEqual(S.seen[0], { atyp: 3, host: "localhost" }, "socks5h: the proxy resolves the name");
    const ws = new WebSocket(`ws://localhost:${wport}`, route.ws(`ws://localhost:${wport}`));
    assert.strictEqual(await new Promise((resolve, reject) => { ws.on("open", () => ws.send("s")); ws.on("message", (m) => resolve(String(m))); ws.on("error", reject); }), "echo:s");
    ws.close();
    route.close();
    const picky = createProxyRoute(() => `socks5://127.0.0.1:${srport}`, { hosts: HOSTS });
    assert.deepStrictEqual(JSON.parse(await picky.request(url("/plain", "localhost"))), { ok: true, via: "plain" });
    assert.deepStrictEqual(SR.seen.map((x) => [x.atyp, x.host]), [[3, "localhost"], [1, "127.0.0.1"]], "the name refused, IPv4 tried");
    assert.strictEqual(picky.describe().route, "ipv4");
    await picky.request(url("/gzip", "localhost"));
    assert.deepStrictEqual(SR.seen.slice(2).map((x) => x.atyp), [], "the kept tunnel is reused");
    assert.strictEqual(Object.keys(picky.ws(`ws://localhost:${wport}`)).sort().join(), "agent,lookup", "sockets take the IPv4 route too");
    picky.close();
    const login = createProxyRoute(() => `socks5://u:pw@127.0.0.1:${saport}`, { hosts: HOSTS });
    assert.deepStrictEqual(JSON.parse(await login.request(url("/plain"))), { ok: true, via: "plain" });
    login.close();
    const wrong = createProxyRoute(() => `socks5://u:nope@127.0.0.1:${saport}`, { hosts: HOSTS });
    assert.strictEqual(await codeOf(wrong.request(url("/plain"))), "agents_proxy_auth");
    wrong.close();
  }

  // --- the ring: the same proxy in Chromium's terms --------------------------------------------------------------------
  assert.deepStrictEqual(chromiumProxy(""), { ok: true, rules: null, auth: null });
  assert.deepStrictEqual(chromiumProxy("10.0.0.1:3128"), { ok: true, rules: "http://10.0.0.1:3128", auth: null, host: "10.0.0.1" });
  assert.deepStrictEqual(chromiumProxy("http://a%40b:p%3Ass@gr.example:8080"), { ok: true, rules: "http://gr.example:8080", auth: { username: "a@b", password: "p:ss" }, host: "gr.example" });
  assert.deepStrictEqual(chromiumProxy("socks5h://gr.example:1080").rules, "socks5://gr.example:1080");
  assert.deepStrictEqual(chromiumProxy("socks5://u:p@gr.example:1080"), { ok: false, reason: "ring_proxy_socks_auth" });
  assert.deepStrictEqual(chromiumProxy("ftp://gr.example"), { ok: false, reason: "agents_proxy_invalid" });

  // --- the lanes: Polymarket's sockets through the proxy, Binance direct; no start while the proxy is unusable --------
  {
    let broken = false;
    const proxy = {
      ws: (u) => { if (broken) throw Object.assign(new Error("agents_proxy_invalid"), { code: "agents_proxy_invalid" }); return /polymarket\.com/.test(u) ? { agent: "via" } : undefined; },
      wsError() {},
    };
    const quiet = { async json() { throw Object.assign(new Error("agents_timeout"), { code: "agents_timeout" }); } };
    broken = true;
    const lat = new L.LatencyLane({ root: tmp(), net: quiet, WebSocketImpl: FakeWS, proxy });
    lat.start({ capitalUsd: 100 });
    assert.deepStrictEqual([lat.running, lat.error, FakeWS.all.length], [false, "agents_proxy_invalid", 0]);
    broken = false;
    lat.start({ capitalUsd: 100 });
    await turn(20);
    const clob = FakeWS.all.find((w) => /ws-subscriptions-clob/.test(w.url)), bin = FakeWS.all.find((w) => /binance/.test(w.url));
    assert.deepStrictEqual([lat.running, lat.error, clob && clob.opts, bin && bin.opts], [true, null, { agent: "via" }, undefined]);
    lat.stop();
    const mk = (i) => ({ cid: `c${i}`, tok: `y${i}`, tok2: `n${i}`, slug: `m${i}`, ev: `e${i}`, rate: 100, v: 0.03, ms: 10, tick: 0.01, size: 20 });
    broken = true;
    const lp = new L.LpLane({ root: tmp(), net: quiet, WebSocketImpl: FakeWS, proxy, build: async () => [mk(1), mk(2)] });
    lp.start({ capitalUsd: 100, perMarketUsd: 50 });
    assert.deepStrictEqual([lp.running, lp.error], [false, "agents_proxy_invalid"]);
    broken = false;
    lp.start({ capitalUsd: 100, perMarketUsd: 50 });
    await turn(20);
    const rtds = FakeWS.all.find((w) => /ws-live-data/.test(w.url));
    assert.deepStrictEqual([lp.running, rtds && rtds.opts], [true, { agent: "via" }]);
    // the proxy breaks while the lane runs: no new socket opens, the lane says why and comes back with the proxy
    broken = true;
    const count = FakeWS.all.length;
    rtds.close();
    await turn(2100);
    assert.deepStrictEqual([FakeWS.all.length - count, lp.error], [0, "agents_proxy_invalid"]);
    broken = false;
    await turn(5100);
    assert.deepStrictEqual([FakeWS.all.length - count, lp.error], [1, null]);
    lp.stop();
  }

  // --- the LP universe: pages by rate until one has nothing at $5/day, a failed page asked again ----------------------
  {
    const asked = [];
    let flaky = 1;
    const row = (i, rate) => ({ condition_id: `c${i}`, market_slug: `m${i}`, tokens: [{ token_id: `y${i}` }, { token_id: `n${i}` }], end_date: "2027-01-01 00:00:00+00",
      rewards_max_spread: 3, rewards_min_size: 10, rewards_config: [{ rate_per_day: rate, start_date: "2026-01-01", end_date: "2027-01-01" }] });
    const pages = { "": { data: [row(1, 50), row(2, 6)], next_cursor: "p2" }, p2: { data: [row(3, 4), row(4, 1)], next_cursor: "p3" }, p3: { data: [row(5, 99)], next_cursor: "LTE=" } };
    const fake = {
      async json(u) {
        asked.push(u);
        if (u.includes("/books")) return [];
        if (flaky-- > 0) throw Object.assign(new Error("agents_proxy_dropped"), { code: "agents_proxy_dropped" });
        return pages[new URL(u).searchParams.get("next_cursor") || ""];
      },
    };
    const waits = [];
    const U = await L.buildLpUniverse(fake, { capitalUsd: 1000, now: Date.UTC(2026, 10, 5), pause: async (ms) => { waits.push(ms); } });
    const rewards = asked.filter((u) => u.includes("/rewards/"));
    assert.deepStrictEqual([rewards.length, rewards.some((u) => u.includes("next_cursor=p3")), waits, Array.isArray(U)], [3, false, [1000], true],
      "page 1 twice (one retry), page 2, and page 3 is never asked");
    const refused = { async json() { asked.push("x"); throw Object.assign(new Error("agents_proxy_invalid"), { code: "agents_proxy_invalid" }); } };
    const n0 = asked.length;
    assert.strictEqual(await codeOf(L.buildLpUniverse(refused, { capitalUsd: 1000, pause: async () => {} })), "agents_proxy_invalid");
    assert.strictEqual(asked.length - n0, 1, "a refusal that cannot change is not asked again");
  }

  // --- the desk: the proxy getter reaches its requests, its lanes and its status ------------------------------------------
  {
    const real = globalThis.fetch, fetched = [];
    globalThis.fetch = async (u) => { fetched.push(String(u)); throw new Error("offline"); };
    try {
      const desk = new AgentDesk({ root: tmp(), proxy: () => "ftp://broken", autoTick: false });
      assert.deepStrictEqual(desk.status().proxy, { on: true, url: "ftp://broken", route: null, error: "agents_proxy_invalid" });
      assert.strictEqual(await codeOf(desk.net.json("https://gamma-api.polymarket.com/events?limit=1")), "agents_proxy_invalid");
      assert.strictEqual(desk.lanes.latency.proxy, desk.proxy);
      assert.deepStrictEqual(fetched, [], "Polymarket is never fetched directly");
      desk.dispose();
      const plain = new AgentDesk({ root: tmp(), autoTick: false, lanes: false });
      assert.deepStrictEqual(plain.status().proxy, { on: false, url: "", route: null, error: null });
      plain.dispose();
    } finally { globalThis.fetch = real; }
  }

  for (const s of sockets) s.destroy();
  for (const server of [T.server, P.server, PA.server, S.server, SR.server, SA.server]) server.close();
  wss.close();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  console.log("agents proxy tests ok");
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
