"use strict";

/**
 * Proxy transport: SOCKS routes, fallback, error codes, clock skew.
 * A local SOCKS5 server stands in for the proxy; nothing leaves the machine.
 */

const assert = require("assert");
const net = require("net");
const {
  ClobClient,
  setProxy,
  currentProxy,
  requestJson,
  describeNetworkError,
  serverNowMs,
} = require("./clobClient");

/**
 * Minimal SOCKS5 server (RFC 1928/1929). `decide({ atyp, host })` returns the
 * reply code; on 0 it grants and closes, which is enough to prove the route.
 */
function socksServer({ decide, auth = null }) {
  const seen = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", (hello) => {
      const wantsUserPass = [...hello.slice(2, 2 + hello[1])].includes(2);
      if (auth && !wantsUserPass) return sock.end(Buffer.from([5, 0xff]));
      sock.write(Buffer.from([5, auth ? 2 : 0]));
      const onRequest = (req) => {
        const atyp = req[3];
        let host;
        if (atyp === 1) host = [...req.slice(4, 8)].join(".");
        else if (atyp === 3) host = req.slice(5, 5 + req[4]).toString();
        else host = "ipv6";
        seen.push({ atyp, host });
        const rep = decide({ atyp, host });
        sock.end(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
      };
      if (!auth) return sock.once("data", onRequest);
      sock.once("data", (cred) => {
        const ulen = cred[1];
        const user = cred.slice(2, 2 + ulen).toString();
        const pass = cred.slice(3 + ulen, 3 + ulen + cred[2 + ulen]).toString();
        const good = user === auth.user && pass === auth.pass;
        sock.write(Buffer.from([1, good ? 0 : 1]));
        if (!good) return sock.end();
        sock.once("data", onRequest);
      });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

const TARGET = "https://localhost:9/time";
const REFUSED = 5;

(async () => {
  // ── socks5:// goes to the proxy by name first (remote DNS) ────────────────
  {
    const { server, seen, port } = await socksServer({ decide: () => 0 });
    setProxy(`socks5://127.0.0.1:${port}`);
    const res = await requestJson(TARGET, { timeoutMs: 3000 });
    assert.strictEqual(seen[0].atyp, 3, "host name is handed to the proxy");
    assert.strictEqual(seen[0].host, "localhost");
    assert.strictEqual(seen.length, 1, "no fallback when the proxy opens the tunnel");
    assert.ok(res.networkError && !/Socks5 proxy rejected/.test(res.networkError), "past the SOCKS handshake");
    server.close();
  }

  // ── proxy refuses the name (IPv6 / DNS trouble): IPv4 fallback, then sticky ─
  {
    const { server, seen, port } = await socksServer({ decide: ({ atyp }) => (atyp === 3 ? REFUSED : 0) });
    setProxy(`socks5://127.0.0.1:${port}`);
    await requestJson(TARGET, { timeoutMs: 3000 });
    assert.deepStrictEqual(seen.map((s) => s.atyp), [3, 1], "name refused, IPv4 tried");
    assert.strictEqual(seen[1].host, "127.0.0.1", "fallback resolves IPv4 only");
    assert.strictEqual(currentProxy().route, "ipv4", "working route remembered");
    await requestJson(TARGET, { timeoutMs: 3000 });
    assert.deepStrictEqual(seen.map((s) => s.atyp), [3, 1, 1], "next call goes straight to IPv4");
    server.close();
  }

  // ── the fallback also covers POST: a refused handshake sent no bytes ─────
  {
    const { server, seen, port } = await socksServer({ decide: ({ atyp }) => (atyp === 3 ? REFUSED : 0) });
    setProxy(`socks5h://127.0.0.1:${port}`);
    await requestJson(TARGET, { method: "POST", body: { a: 1 }, timeoutMs: 3000 });
    assert.strictEqual(seen.length, 2, "POST retried only across the refused handshake");
    server.close();
  }

  // ── proxy cannot reach Polymarket on any route: clear code, both reasons ──
  {
    const { server, seen, port } = await socksServer({ decide: () => REFUSED });
    setProxy(`socks5://127.0.0.1:${port}`);
    const res = await requestJson(TARGET, { timeoutMs: 3000 });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(res.errorCode, "proxy_target_refused");
    assert.ok(/ConnectionRefused; ipv4: .*ConnectionRefused/.test(res.networkError), res.networkError);
    server.close();
  }

  // ── login ───────────────────────────────────────────────────────────────
  {
    const { server, seen, port } = await socksServer({ decide: () => 0, auth: { user: "u", pass: "p" } });
    setProxy(`socks5://u:wrong@127.0.0.1:${port}`);
    const bad = await requestJson(TARGET, { timeoutMs: 3000 });
    assert.strictEqual(bad.errorCode, "proxy_auth", bad.networkError);
    assert.ok(!currentProxy().url.includes("wrong"), "password never echoed");
    setProxy(`socks5://u:p@127.0.0.1:${port}`);
    await requestJson(TARGET, { timeoutMs: 3000 });
    assert.strictEqual(seen.length, 1, "right login reaches CONNECT");
    server.close();
  }

  // ── nothing listening at the proxy address ────────────────────────────────
  {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    setProxy(`socks5://127.0.0.1:${port}`);
    const res = await requestJson(TARGET, { timeoutMs: 3000 });
    assert.strictEqual(res.errorCode, "proxy_down", res.networkError);
  }

  // ── bad scheme never goes direct ──────────────────────────────────────────
  {
    setProxy("ftp://127.0.0.1:21");
    const res = await requestJson(TARGET);
    assert.strictEqual(res.errorCode, "proxy_invalid");
    setProxy("");
  }

  assert.strictEqual(describeNetworkError("connect ETIMEDOUT 1.2.3.4:443", { proxied: false }), "timeout");
  assert.strictEqual(describeNetworkError("getaddrinfo ENOTFOUND clob.polymarket.com", { proxied: false }), "dns");
  assert.strictEqual(describeNetworkError("Proxy connection timed out", { proxied: true }), "proxy_timeout");

  // ── L2 timestamps follow the CLOB clock, not a drifting PC clock ─────────
  {
    const serverSec = Math.floor(Date.now() / 1000) - 120;
    const client = new ClobClient({ request: async () => ({ ok: true, status: 200, json: serverSec, raw: String(serverSec) }) });
    await client.time();
    assert.ok(Math.abs(serverNowMs() / 1000 - serverSec) < 3, "clock skew applied");
  }

  console.log("proxy tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
