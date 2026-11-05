"use strict";

// The agents' road to Polymarket. Polymarket geoblocks some countries (Belarus among them) and some networks cut it
// off, so the desk and its V2 lanes reach Polymarket the way orders do: through the proxy from the API panel, over the
// same SOCKS routes and under the same rule — a proxy that is set but unusable is never bypassed. Only Polymarket goes
// through it; Binance, Coinbase, Deribit and the weather sources stay direct, which keeps the proxy's traffic to what
// needs it.

const dns = require("dns");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { normalizeProxyUrl, isSocksTargetError, describeNetworkError } = require("../brokers/clobClient");

const POLYMARKET = /(^|\.)polymarket\.com$/i;
const DROPPED = /socket hang up|ECONNRESET|Socket closed|aborted/i;
const SOCKS = /^socks(4a?|5h?)?$/;
const APP_VERSION = (() => { try { return require("../../../package.json").version; } catch { return "dev"; } })();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const mask = (url) => url.replace(/\/\/[^@/]*@/, "//***@");
const withScheme = (url, scheme) => url.replace(/^[a-z][a-z0-9+.-]*:/i, `${scheme}:`);
const schemeOf = (url) => new URL(url).protocol.replace(/:$/, "").toLowerCase();
// the fallback route resolves on this side, IPv4 only (see clobClient: some proxies refuse names or cannot reach IPv6)
const ipv4Lookup = (host, opts, cb) => dns.lookup(host, { ...(opts && typeof opts === "object" ? opts : {}), family: 4 }, cb);

// A raw network failure through the proxy, as one of the agents' codes.
function codeOf(error) {
  if (error && typeof error.code === "string" && error.code.startsWith("agents_")) return error.code;
  const c = describeNetworkError(String((error && error.message) || error || "network"), { proxied: true });
  if (c && c.startsWith("proxy_")) return `agents_${c}`;
  return c === "timeout" ? "agents_timeout" : "agents_source_unavailable";
}

// Two sets of agents per proxy: the requests keep their tunnels alive between polls (one handshake, not one per poll);
// the sockets get their own, since a WebSocket keeps its tunnel for itself.
function agentsFor(url) {
  const scheme = schemeOf(url);
  const make = (keepAlive) => {
    if (SOCKS.test(scheme)) {
      const { SocksProxyAgent } = require("socks-proxy-agent");
      const v4 = scheme.startsWith("socks4");
      return { remote: new SocksProxyAgent(withScheme(url, v4 ? "socks4a" : "socks5h"), { keepAlive }),
        ipv4: new SocksProxyAgent(withScheme(url, v4 ? "socks4" : "socks5"), { keepAlive }) };
    }
    if (scheme === "http" || scheme === "https") {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      return { remote: new HttpsProxyAgent(url, { keepAlive }), ipv4: null };
    }
    throw new Error(`unsupported proxy scheme: ${scheme}`);
  };
  return { socks: SOCKS.test(scheme), rest: make(true), ws: make(false) };
}

// One request over one route: the whole exchange under one timer, the body decompressed and capped as it arrives.
function send(target, { method, headers, payload, timeout, maxBytes, agent, lookup }) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const plain = u.protocol === "http:";
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = (plain ? http : https).request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (plain ? 80 : 443), path: `${u.pathname}${u.search}`, method, agent,
      ...(lookup ? { lookup } : {}),
      headers: { "user-agent": `Vespera/${APP_VERSION}`, "accept-encoding": "gzip, br", ...headers, ...(payload ? { "content-length": payload.length } : {}) },
    }, (res) => {
      // an error status needs no body; a proxy's own refusal (407 and the like) comes back this way, with a body
      // that may be cut short, so it is not read
      if (res.statusCode < 200 || res.statusCode >= 300) { finish(null, { status: res.statusCode, text: "" }); req.destroy(); return; }
      const enc = String(res.headers["content-encoding"] || "identity").trim().toLowerCase();
      const body = enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip() : enc === "br" ? zlib.createBrotliDecompress()
        : enc === "deflate" ? zlib.createInflate() : enc === "identity" ? null : false;
      if (body === false) { req.destroy(); finish(fail("agents_source_unavailable")); return; }
      const chunks = [];
      let size = 0;
      const stream = body || res;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { finish(fail("agents_response_too_large")); req.destroy(); if (body) body.destroy(); return; }
        chunks.push(chunk);
      });
      stream.on("end", () => finish(null, { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", (error) => finish(error));
      res.on("error", (error) => finish(error));
      res.on("close", () => { if (!res.complete) finish(new Error("socket hang up")); });
      if (body) res.pipe(body);
    });
    const timer = setTimeout(() => { finish(fail("agents_timeout")); req.destroy(); }, timeout);
    timer.unref?.();
    req.on("error", (error) => finish(error));
    req.end(payload || undefined);
  });
}

/**
 * The route for the desk. `getUrl` returns the proxy from the API panel ("" = none) and is read on every call, so an
 * edit there applies to the next request and the next socket.
 * covers(url): this URL must go through the proxy. request(url, options): its body as text. ws(url): the options for
 * a WebSocket to that URL (undefined = direct). Both throw agents_proxy_invalid while the proxy is set but unusable.
 */
function createProxyRoute(getUrl, { hosts = POLYMARKET } = {}) {
  const read = typeof getUrl === "function" ? getUrl : () => getUrl;
  let url = "", set = null, route = "remote", lastError = null;

  function release() {
    for (const group of set ? [set.rest, set.ws] : []) for (const agent of Object.values(group)) { try { agent?.destroy(); } catch { /* closing */ } }
    set = null;
  }
  function current() {
    const next = normalizeProxyUrl(read());
    if (next !== url) {
      release();
      url = next;
      route = "remote";
      lastError = null;
      if (url) { try { set = agentsFor(url); } catch { set = null; } }   // stays unusable until the address changes
    }
    return url;
  }
  const note = (error) => { lastError = error.code; return error; };
  const usable = () => { if (!set) throw note(fail("agents_proxy_invalid")); return set; };
  function covers(target) {
    if (!current()) return false;
    try { return hosts.test(new URL(target).hostname); } catch { return false; }
  }

  async function request(target, { method = "GET", body = null, headers = {}, timeout = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
    current();
    const s = usable();
    const payload = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const go = (r) => send(target, { method, headers, payload, timeout, maxBytes, agent: s.rest[r], lookup: r === "ipv4" ? ipv4Lookup : null });
    const first = s.socks ? route : "remote";
    let res = null, error = null;
    try { res = await go(first); } catch (e) { error = e; }
    if (error && s.socks && isSocksTargetError(error.message)) {
      // refused during the SOCKS handshake, before a byte of the request: the other route cannot repeat anything
      const other = first === "remote" ? "ipv4" : "remote";
      try { res = await go(other); error = null; } catch (e) { error = e; }
      if (!error || !isSocksTargetError(error.message)) route = other;   // the proxy opened this route: keep it
    } else if (error && DROPPED.test(error.message)) {
      // one retry for a dropped read; the desk only reads (a POST /books is a read), it never sends an order
      try { res = await go(first); error = null; } catch (e) { error = e; }
    }
    if (error) throw note(fail(codeOf(error)));
    lastError = null;
    if (res.status === 407) throw note(fail("agents_proxy_auth"));
    if (res.status < 200 || res.status >= 300) throw fail(res.status === 429 ? "agents_rate_limited" : `agents_http_${res.status}`);
    return res.text;
  }

  function ws(target) {
    if (!covers(target)) return undefined;
    const s = usable();
    const r = s.socks ? route : "remote";
    return r === "ipv4" ? { agent: s.ws.ipv4, lookup: ipv4Lookup } : { agent: s.ws.remote };
  }

  // A socket that went through the proxy failed: a SOCKS refusal moves the next socket to the other route.
  function wsError(error) {
    if (!url) return;
    const e = error && error.error ? error.error : error;
    const msg = String((e && e.message) || e || "");
    if (!msg) return;
    if (set && set.socks && isSocksTargetError(msg)) route = route === "remote" ? "ipv4" : "remote";
    note(fail(codeOf(e)));
  }

  function describe() {
    current();
    return { on: Boolean(url), url: url ? mask(url) : "", route: set && set.socks ? route : null, error: url && !set ? "agents_proxy_invalid" : lastError };
  }

  return { covers, request, ws, wsError, describe, close: () => { release(); url = ""; } };
}

/**
 * The same proxy for Chromium (the ring window). Chromium takes HTTP(S) proxies, with the login answered from the
 * app, and SOCKS without a password; it has no SOCKS authentication, so a SOCKS proxy with a login is refused rather
 * than bypassed.
 */
function chromiumProxy(raw) {
  const url = normalizeProxyUrl(raw);
  if (!url) return { ok: true, rules: null, auth: null };
  let u, scheme;
  try { u = new URL(url); scheme = schemeOf(url); } catch { return { ok: false, reason: "agents_proxy_invalid" }; }
  if (!u.hostname) return { ok: false, reason: "agents_proxy_invalid" };
  const host = u.hostname.includes(":") && !u.hostname.startsWith("[") ? `[${u.hostname}]` : u.hostname;
  const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || "") } : null;
  if (scheme === "http" || scheme === "https") return { ok: true, rules: `${scheme}://${host}:${u.port || (scheme === "https" ? 443 : 80)}`, auth, host: u.hostname };
  if (SOCKS.test(scheme)) {
    if (auth) return { ok: false, reason: "ring_proxy_socks_auth" };
    return { ok: true, rules: `${scheme.startsWith("socks4") ? "socks4" : "socks5"}://${host}:${u.port || 1080}`, auth: null, host: u.hostname };
  }
  return { ok: false, reason: "agents_proxy_invalid" };
}

module.exports = { createProxyRoute, chromiumProxy, POLYMARKET };
