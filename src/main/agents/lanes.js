"use strict";

// Fast lanes: two strategies that cannot live on the desk's one-minute tick. Paper only: public data, no keys, no
// orders. Each lane keeps a small ledger in <root>/lanes/<name>.json; the desk folds its P&L into the agent's stats,
// the equity and the stops, and starts or stops the lane with the desk and the agent.
//  - latency (a9): a Binance jump of more than 2 bps within 1 s buys the jump side of Polymarket's BTC Up/Down 5m at
//    the best ask as of the Binance trade time + 150 ms (at most 100 shares, taker fee) and sells it at the best bid
//    10 s later (second fee). Rule latarb_v1, frozen 2026-11-05, passed out of sample (research/v2money/RESULTS.md).
//  - lp_rewards (a10): two-sided quotes on liquidity-reward markets, re-quoted every few seconds, with a news shield;
//    rewards by Polymarket's scoring formula with a pessimistic share; fills from RTDS taker trades that reach the
//    quote and from book crossings. Variant "h" of research/v2money/lp_paper.js plus the shield of addendum C.

const fs = require("fs");
const path = require("path");
const { takerFee } = require("../fees");
const { LatCert, lpSummary } = require("./v2cert");
let WS_IMPL = null;
try { WS_IMPL = require("ws"); } catch { WS_IMPL = globalThis.WebSocket || null; }

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const EPS = 1e-9;
const HOUR = 3600000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const RTDS_WS = "wss://ws-live-data.polymarket.com";
const BINANCE_WS = ["wss://stream.binance.com:9443", "wss://data-stream.binance.vision"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// ---- store ----------------------------------------------------------------------------------------------------------

function readJson(file, maxBytes = 16 * 1024 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
// The lanes' trade logs: room for weeks of the V2 test, so its trades can be checked apart from the certificate;
// past the cap the file moves to .1 (one generation).
function appendCapped(file, row, maxBytes = 64 * 1024 * 1024) {
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* a new file */ }
    if (size > maxBytes) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch { /* the trade log is a convenience; the ledger is the record */ }
}
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const dayStart = (t) => Math.floor(t / 86400000) * 86400000;

// Hourly rows [hour, trades, settled, wins, pnl, fees] for the reports and the journal; the last 8 days are kept.
const HIST_ROWS = 200;
function bump(hist, now, d) {
  const h = Math.floor(now / HOUR);
  let row = hist[hist.length - 1];
  if (!row || row[0] !== h) {
    row = [h, 0, 0, 0, 0, 0];
    hist.push(row);
    if (hist.length > HIST_ROWS) hist.splice(0, hist.length - HIST_ROWS);
  }
  row[1] += d.trades || 0;
  row[2] += d.settled || 0;
  row[3] += d.wins || 0;
  row[4] = r6(row[4] + (d.pnl || 0));
  row[5] = r6(row[5] + (d.fees || 0));
}
function periodOf(hist, from, to = Infinity) {
  const out = { trades: 0, settled: 0, wins: 0, pnl: 0, fees: 0 };
  for (const [h, t, s, w, p, f] of hist) {
    if ((h + 1) * HOUR <= from || h * HOUR >= to) continue;
    out.trades += t;
    out.settled += s;
    out.wins += w;
    out.pnl += p;
    out.fees += f;
  }
  return { ...out, pnl: r2(out.pnl), fees: r2(out.fees) };
}
const validHist = (x) => Array.isArray(x) && x.every((row) => Array.isArray(row) && row.length === 6 && row.every(finite));
// The finished hours not yet reported: one journal line each.
function finishedHours(hist, emitted, now) {
  const h = Math.floor(now / HOUR);
  return { rows: hist.filter((row) => row[0] >= emitted && row[0] < h), next: h };
}

function freshLedger(now) {
  return { trades: 0, closed: 0, wins: 0, realized: 0, fees: 0, hist: [], emitted: Math.floor(now / HOUR), recent: [], startedAt: now };
}
function validLedger(x) {
  return Boolean(x) && typeof x === "object" && [x.trades, x.closed, x.wins, x.realized, x.fees, x.emitted, x.startedAt].every(finite) &&
    validHist(x.hist) && Array.isArray(x.recent);
}

// A Polymarket socket goes through the app's proxy when one is set (proxy.js); Binance stays direct. A proxy that is set
// but unusable is never bypassed: the socket is not opened, the lane says why and tries again in five seconds.
const PROXIED = new WeakSet();
function openSocket(lane, url) {
  let opts;
  try { opts = lane.proxy ? lane.proxy.ws(url) : undefined; } catch (error) { lane.error = (error && error.code) || "agents_proxy_invalid"; return null; }
  // the browser-style WebSocket takes no agent and would go direct
  if (opts && typeof globalThis.WebSocket === "function" && lane.WS === globalThis.WebSocket) { lane.error = "agents_lane_no_websocket"; return null; }
  const ws = opts ? new lane.WS(url, opts) : new lane.WS(url);
  if (opts) PROXIED.add(ws);
  return ws;
}
function socketOpened(lane) { if (/^agents_proxy_/.test(lane.error || "")) lane.error = null; }
function socketFailed(lane, ws, event) { if (PROXIED.has(ws) && lane.proxy && typeof lane.proxy.wsError === "function") lane.proxy.wsError(event); }
// The lane does not start while the proxy is set but unusable; it would only reach Binance.
function proxyBlocked(lane) {
  if (!lane.proxy) return false;
  try { lane.proxy.ws(lane.type === "latency" ? CLOB_WS : RTDS_WS); return false; } catch (error) { lane.error = (error && error.code) || "agents_proxy_invalid"; return true; }
}

// Timers and sockets that one stop() clears.
class Lifecycle {
  constructor() { this.timers = new Set(); this.sockets = new Set(); }
  after(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, Math.max(0, ms));
    t.unref?.();
    this.timers.add(t);
    return t;
  }
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }
  clear() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
    for (const ws of this.sockets) { try { ws.onclose = null; ws.close(); } catch { /* already closed */ } }
    this.sockets.clear();
  }
}

// ---- latency: the core (pure, testable) ----------------------------------------------------------------------------

// maxJumps5m: the quiet-market filter under test (research addendum B), off by default: the lane trades the frozen
// rule. maxDayLossPct: the lane stops for the rest of the UTC day once the day's loss reaches this share of its capital;
// off for the V2 test, where a stop after a loss would bias the sample (the kill switch of latarb_v2 stops it instead).
// shadows: "asset tf" pairs traded by the same rule on paper for the certificate only (latarb_v2: BTC 15m secondary,
// ETH the control); they never touch the lane's ledger, capital or P&L.
const LAT_DEFAULTS = Object.freeze({
  assets: ["btc"], tfs: ["5m"], jumpBps: 2, coolMs: 3000, latencyMs: 150, transitMs: 50,
  maxShares: 100, holdMs: 10000, edgeMs: 5000, feeRate: 0.07, maxJumps5m: null, maxDayLossPct: null,
  shadows: Object.freeze(["btc 15m", "eth 5m", "eth 15m"]),
});
const WINDOW_S = Object.freeze({ "5m": 300, "15m": 900 });
const SYMBOL = Object.freeze({ btc: "BTCUSDT", eth: "ETHUSDT", sol: "SOLUSDT", xrp: "XRPUSDT" });

class LatencyCore {
  constructor(params = {}) {
    this.p = { ...LAT_DEFAULTS, ...params };
    this.windows = new Map();
    this.byToken = new Map();
    this.ticks = Object.fromEntries(this.p.assets.map((a) => [a, { T: [], lp: [], lastEv: -Infinity, jumps: [] }]));
  }

  addWindow(w) {
    if (this.windows.has(w.slug)) return false;
    const row = { slug: w.slug, asset: w.asset, tf: w.tf, start: w.start, end: w.end, up: w.up, shadow: Boolean(w.shadow), hist: [], book: null };
    this.windows.set(w.slug, row);
    this.byToken.set(w.up, row);
    return true;
  }
  dropWindow(slug) {
    const w = this.windows.get(slug);
    if (!w) return;
    this.windows.delete(slug);
    this.byToken.delete(w.up);
  }
  // A full book of the Up token (the Down book is its mirror), then level changes; ts is the CLOB server time.
  book(token, ts, bids, asks) {
    const w = this.byToken.get(token);
    if (!w) return;
    w.book = { bids: new Map(bids.map((q) => [+q.price, +q.size])), asks: new Map(asks.map((q) => [+q.price, +q.size])) };
    this._push(w, ts);
  }
  change(token, ts, side, price, size) {
    const w = this.byToken.get(token);
    if (!w || !w.book) return;
    const levels = side === "BUY" ? w.book.bids : w.book.asks;
    if (+size === 0) levels.delete(+price); else levels.set(+price, +size);
    this._push(w, ts);
  }
  clearBooks() { for (const w of this.windows.values()) w.book = null; }
  _push(w, ts) {
    let bb = -1, ba = 2;
    for (const p of w.book.bids.keys()) if (p > bb) bb = p;
    for (const p of w.book.asks.keys()) if (p < ba) ba = p;
    if (!(bb > 0) || !(ba < 1.5)) return;   // a state with an empty side is skipped, as in the research
    const row = [ts, bb, w.book.bids.get(bb), ba, w.book.asks.get(ba)], h = w.hist, last = h[h.length - 1];
    if (last && last[1] === row[1] && last[2] === row[2] && last[3] === row[3] && last[4] === row[4]) return;
    h.push(row);
    while (h.length > 2 && (h.length > 50000 || h[0][0] < ts - 20 * 60000)) h.shift();
  }
  at(w, ts) {
    const h = w.hist;
    let lo = 0, hi = h.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (h[m][0] <= ts) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r >= 0 ? h[r] : null;
  }
  // A Binance trade: the jump when the 1 s log return passes the threshold (one per cooldown per asset), else null.
  // recent: the asset's jumps in the 5 minutes before this one (how busy the market is).
  trade(asset, T, price) {
    const s = this.ticks[asset];
    if (!s || !(price > 0) || !finite(T)) return null;
    const lp = Math.log(price);
    s.T.push(T);
    s.lp.push(lp);
    while (s.T.length > 2 && s.T[1] <= T - 5000) { s.T.shift(); s.lp.shift(); }
    let i = -1;
    for (let k = s.T.length - 1; k >= 0; k -= 1) if (s.T[k] <= T - 1000) { i = k; break; }
    if (i < 0) return null;
    const bps = (lp - s.lp[i]) * 1e4;
    if (Math.abs(bps) <= this.p.jumpBps || T - s.lastEv <= this.p.coolMs) return null;
    s.lastEv = T;
    while (s.jumps.length && s.jumps[0] <= T - 300000) s.jumps.shift();
    const recent = s.jumps.length;
    s.jumps.push(T);
    return { asset, T, sign: Math.sign(bps), bps: r2(bps), recent };
  }
  targets(jump) {
    return [...this.windows.values()].filter((w) => w.asset === jump.asset && jump.T >= w.start + this.p.edgeMs && jump.T <= w.end - this.p.edgeMs);
  }
  // Buying the jump side at ts: the Up ask, or for Down 1 − the Up bid; null when there is nothing sensible to buy.
  entry(w, sign, ts, maxShares = this.p.maxShares) {
    const q = this.at(w, ts);
    if (!q) return null;
    const px = sign > 0 ? q[3] : r4(1 - q[1]), avail = sign > 0 ? q[4] : q[2];
    const shares = Math.floor(Math.min(avail, maxShares) * 100) / 100;
    if (px >= 0.99 || px <= 0.01 || !(shares > 0)) return null;
    return { px, shares, fee: r6(takerFee(shares, px, { rate: this.p.feeRate })) };
  }
  // Selling the held side at ts: the Up bid, or for Down 1 − the Up ask.
  exit(w, sign, ts) {
    const q = this.at(w, ts);
    if (!q) return null;
    return { px: sign > 0 ? q[1] : r4(1 - q[3]), shares: sign > 0 ? q[2] : q[4] };
  }
}

// ---- latency: the lane (sockets, timers, ledger) -------------------------------------------------------------------

class LatencyLane {
  constructor({ root, net, WebSocketImpl = WS_IMPL, now = () => Date.now(), params = {}, onEvent = () => {}, proxy = null } = {}) {
    if (!root) throw new TypeError("root is required");
    this.type = "latency";
    this.file = path.join(root, "latency.json");
    this.tradeLog = path.join(root, "latency-trades.jsonl");
    this.shadowLog = path.join(root, "latency-shadow.jsonl");
    this.certFile = path.join(root, "latency-cert.json");
    this.net = net;
    this.WS = WebSocketImpl;
    this.proxy = proxy;
    this.now = now;
    this.onEvent = onEvent;
    this.params = { ...LAT_DEFAULTS, ...params };
    const saved = readJson(this.file);
    this.ledger = saved && validLedger(saved.ledger) ? saved.ledger : freshLedger(now());
    this.held = saved && Array.isArray(saved.held) ? saved.held.filter((p) => p && typeof p.slug === "string" && finite(p.cost) && finite(p.shares)) : [];
    this.cert = new LatCert(readJson(this.certFile), now());
    this.outcomes = new Map();
    this.combos = [];
    this.open = [];
    this.running = false;
    this.error = null;
    this.feeds = { binance: null, clob: null, jumps: 0, lastJumpAt: null };
    this.life = new Lifecycle();
    this.core = null;
    this.seq = 0;
    this.limits = { capitalUsd: 0, perTradeUsd: Infinity };
  }

  start({ capitalUsd = 0, perTradeUsd = Infinity, params = {} } = {}) {
    if (this.running) return;
    if (typeof this.WS !== "function") { this.error = "agents_lane_no_websocket"; return; }
    if (proxyBlocked(this)) return;
    this.limits = { capitalUsd, perTradeUsd };
    const p = { ...this.params, ...params };
    // the traded windows, then the shadows (same rule, certificate only)
    const traded = [];
    for (const a of p.assets) for (const tf of p.tfs) if (SYMBOL[a] && WINDOW_S[tf]) traded.push(`${a} ${tf}`);
    const shadows = (Array.isArray(p.shadows) ? p.shadows : []).filter((k) => typeof k === "string" && SYMBOL[k.split(" ")[0]] && WINDOW_S[k.split(" ")[1]] && !traded.includes(k));
    this.combos = [...traded.map((k) => [k, false]), ...[...new Set(shadows)].map((k) => [k, true])];
    this.primary = p.assets[0];
    this.core = new LatencyCore({ ...p, assets: [...new Set(this.combos.map(([k]) => k.split(" ")[0]))] });
    this.running = true;
    this.error = null;
    this.subs = new Set();
    this.cert.upAt = null;
    this.life.every(30000, () => { this._windows().catch(() => {}); });
    this.life.every(15000, () => { this._resolve().catch(() => {}); });
    this.life.every(10000, () => this._uptime());
    this.life.every(60000, () => this._persist());
    this._windows().catch(() => {}).finally(() => {
      if (!this.running) return;
      this._clob();
      this._binance(0);
    });
  }

  stop() {
    if (!this.running) return;
    this._uptime();
    this.running = false;
    this.life.clear();
    // trades still waiting for their 10-second exit are closed at the last known bid
    for (const pos of this.open.splice(0)) this._exitNow(pos, true);
    this._persist();
  }

  async _windows() {
    const now = this.now() / 1000;
    for (const [key, shadow] of this.combos) {
      const [a, tf] = key.split(" ");
      const len = WINDOW_S[tf];
      if (!len) continue;
      const s0 = Math.floor(now / len) * len;
      for (const s of [s0, s0 + len]) {
        const slug = `${a}-updown-${tf}-${s}`;
        if (!this.core || this.core.windows.has(slug)) continue;
        try {
          const rows = await this.net.json(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
          const m = Array.isArray(rows) ? rows[0] : null;
          if (!m || !this.core) continue;
          const toks = JSON.parse(m.clobTokenIds), outs = JSON.parse(m.outcomes);
          const up = toks[outs.indexOf("Up")];
          if (!up) continue;
          if (this.core.addWindow({ slug, asset: a, tf, start: s * 1000, end: (s + len) * 1000, up, shadow })) this._subscribe([up]);
        } catch { /* the next pass retries */ }
      }
    }
    if (!this.core) return;
    const t = this.now();
    for (const w of [...this.core.windows.values()]) {
      if (t > w.end + 2 * 60000 && !this.open.some((p) => p.slug === w.slug)) { this.core.dropWindow(w.slug); this._unsubscribe([w.up]); }
    }
  }

  _subscribe(toks) {
    for (const t of toks) this.subs.add(t);
    if (this.clob && this.clobOpen) { try { this.clob.send(JSON.stringify({ assets_ids: toks, operation: "subscribe", custom_feature_enabled: true })); } catch { /* reconnect resubscribes */ } }
  }
  _unsubscribe(toks) {
    for (const t of toks) this.subs.delete(t);
    if (this.clob && this.clobOpen) { try { this.clob.send(JSON.stringify({ assets_ids: toks, operation: "unsubscribe" })); } catch { /* ignored */ } }
  }

  _clob() {
    if (!this.running) return;
    const ws = openSocket(this, CLOB_WS);
    if (!ws) { this.life.after(5000, () => this._clob()); return; }
    this.clob = ws;
    this.clobOpen = false;
    this.life.sockets.add(ws);
    let last = this.now();
    ws.onopen = () => {
      this.clobOpen = true;
      socketOpened(this);
      last = this.now();
      ws.send(JSON.stringify({ assets_ids: [...this.subs], type: "market", custom_feature_enabled: true }));
    };
    ws.onmessage = (e) => {
      last = this.now();
      this.feeds.clob = last;
      if (typeof e.data !== "string" || (e.data[0] !== "{" && e.data[0] !== "[")) return;
      let j;
      try { j = JSON.parse(e.data); } catch { return; }
      for (const x of Array.isArray(j) ? j : [j]) this._clobMessage(x);
    };
    ws.onclose = () => {
      this.life.sockets.delete(ws);
      this.clobOpen = false;
      this.core?.clearBooks();
      if (this.running) this.life.after(1000, () => this._clob());
    };
    ws.onerror = (e) => { socketFailed(this, ws, e); try { ws.close(); } catch { /* closing */ } };
    const ping = this.life.every(2000, () => {
      if (ws !== this.clob) { clearInterval(ping); return; }
      if (this.clobOpen) { try { ws.send("PING"); } catch { /* closing */ } }
      if (this.now() - last > 15000) { try { ws.close(); } catch { /* closing */ } }
    });
  }

  _clobMessage(x) {
    const et = x.event_type || (x.bids ? "book" : "");
    if (et === "book") this.core.book(x.asset_id, +x.timestamp, x.bids || [], x.asks || []);
    else if (et === "price_change") for (const c of x.price_changes || []) this.core.change(c.asset_id, +x.timestamp, c.side, c.price, c.size);
  }

  _binance(i) {
    if (!this.running) return;
    const streams = this.core.p.assets.map((a) => `${SYMBOL[a].toLowerCase()}@aggTrade`).join("/");
    const ws = new this.WS(`${BINANCE_WS[i % BINANCE_WS.length]}/stream?streams=${streams}`);
    this.life.sockets.add(ws);
    let last = this.now();
    ws.onmessage = (e) => {
      const rt = this.now();
      last = rt;
      this.feeds.binance = rt;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      const d = m && m.data;
      if (!d || d.e !== "aggTrade") return;
      const asset = this.core.p.assets.find((a) => SYMBOL[a] === d.s);
      if (!asset) return;
      const jump = this.core.trade(asset, +d.T, +d.p);
      if (jump) this._onJump(jump, rt);
    };
    ws.onclose = () => {
      this.life.sockets.delete(ws);
      if (this.running) this.life.after(1000, () => this._binance(i + 1));
    };
    ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
    const watch = this.life.every(5000, () => {
      if (!this.life.sockets.has(ws)) { clearInterval(watch); return; }
      if (this.now() - last > 15000) { try { ws.close(); } catch { /* closing */ } }
    });
  }

  _onJump(jump, recvAt) {
    if (jump.asset === this.primary) {
      this.feeds.jumps += 1;
      this.feeds.lastJumpAt = recvAt;
      this.feeds.recent = jump.recent;
    }
    const quiet = this.core.p.maxJumps5m;
    if (quiet != null && jump.recent > quiet) return;
    for (const w of this.core.targets(jump)) {
      // the book as of the later of the research latency and when our order could really have arrived
      const L = Math.max(this.core.p.latencyMs, recvAt - jump.T + this.core.p.transitMs);
      this.life.after(jump.T + L + 1500 - this.now(), () => this._enter(w, jump, L));
    }
  }

  _exposure() { return [...this.open, ...this.held].reduce((s, p) => s + (p.shadow ? 0 : p.cost), 0); }

  // Live feeds: both sockets heard from in the last 30 s. The certificate counts its days by this time.
  _healthy(now) {
    const f = this.feeds;
    return this.running && f.binance != null && now - f.binance < 30000 && f.clob != null && now - f.clob < 30000;
  }
  _uptime() { const now = this.now(); this.cert.uptime(now, this._healthy(now)); }

  // Past the day's loss limit the lane sits out until the next UTC day; the journal hears of it once.
  _dayStopped(now) {
    const limit = ((this.core ? this.core.p.maxDayLossPct : LAT_DEFAULTS.maxDayLossPct) / 100) * this.limits.capitalUsd;
    if (!(limit > 0)) return false;
    const day = this.period(dayStart(now)).pnl;
    if (day > -limit) return false;
    if (this.dayStop !== dayStart(now)) {
      this.dayStop = dayStart(now);
      try { this.onEvent({ lane: this.type, op: "day_stop", pnl: day, limit: -r2(limit) }); } catch { /* the journal never stops a lane */ }
    }
    return true;
  }

  // A shadow window trades by the same rule and size but outside the ledger, the capital and the day's stop.
  _enter(w, jump, L) {
    if (!this.running || !this.core) return;
    const shadow = Boolean(w.shadow);
    if (!shadow && this._dayStopped(this.now())) return;
    let e = this.core.entry(w, jump.sign, jump.T + L);
    if (!e) return;
    const byUsd = Math.floor(this.limits.perTradeUsd / e.px);
    if (byUsd < 1) return;
    if (byUsd < e.shares) e = { ...e, shares: byUsd, fee: r6(takerFee(byUsd, e.px, { rate: this.core.p.feeRate })) };
    const cost = r6(e.shares * e.px + e.fee);
    if (!shadow && this._exposure() + cost > this.limits.capitalUsd + EPS) return;
    const pos = { id: `${shadow ? "s" : "l"}${++this.seq}`, slug: w.slug, asset: w.asset, tf: w.tf, T: jump.T, sign: jump.sign, bps: jump.bps, recent: jump.recent, L,
      px: e.px, shares: e.shares, fee: e.fee, cost, at: this.now(), end: w.end, ...(shadow ? { shadow: true } : {}) };
    this.open.push(pos);
    if (!shadow) {
      this.ledger.trades += 1;
      bump(this.ledger.hist, this.now(), { trades: 1, fees: e.fee });
    }
    this.life.after(jump.T + this.core.p.holdMs + 1500 - this.now(), () => {
      const i = this.open.indexOf(pos);
      if (i >= 0) { this.open.splice(i, 1); this._exitNow(pos, false); }
    });
  }

  _exitNow(pos, early) {
    const w = this.core && this.core.windows.get(pos.slug);
    const x = w ? this.core.exit(w, pos.sign, early ? this.now() : pos.T + this.core.p.holdMs) : null;
    if (!x || !(x.px > 0)) { this.held.push({ ...pos, heldAt: this.now() }); return; }   // nothing to sell into: hold to the result
    const fee = r6(takerFee(pos.shares, x.px, { rate: this.core.p.feeRate }));
    this._close(pos, { exitPx: x.px, exitFee: fee, exitDepth: x.shares, how: early ? "stop" : "bid_10s", pnl: r6(pos.shares * x.px - fee - pos.cost) });
  }

  // The result of a window once Polymarket has resolved it: 1 if Up won, 0 if Down, null while unknown.
  async _outcome(slug) {
    if (this.outcomes.has(slug)) return this.outcomes.get(slug);
    const rows = await this.net.json(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}&closed=true`);
    const m = Array.isArray(rows) ? rows[0] : null;
    if (!m || m.umaResolutionStatus !== "resolved") return null;
    const prices = JSON.parse(m.outcomePrices), outs = JSON.parse(m.outcomes);
    const px = +prices[outs.indexOf("Up")];
    if (!finite(px)) return null;
    const up = px > 0.5 ? 1 : 0;
    this.outcomes.set(slug, up);
    if (this.outcomes.size > 2000) this.outcomes.delete(this.outcomes.keys().next().value);
    return up;
  }

  // Held positions settle at the result; every traded window gets its result for the certificate's edge at
  // resolution, and finished windows fold into its sums.
  async _resolve() {
    for (const pos of [...this.held]) {
      if (this.now() < pos.end + 60000) continue;
      let up = null;
      try { up = await this._outcome(pos.slug); } catch { /* the next pass retries */ }
      const i = this.held.indexOf(pos);
      if (up == null || i < 0) continue;
      const y = pos.sign > 0 ? up : 1 - up;
      this.held.splice(i, 1);
      this._close(pos, { exitPx: y, exitFee: 0, exitDepth: null, how: "result", pnl: r6(pos.shares * y - pos.cost) });
    }
    for (const slug of this.cert.due(this.now(), 8)) {
      let up = null;
      try { up = await this._outcome(slug); } catch { /* retried with a backoff */ }
      if (up == null) this.cert.retry(slug, this.now()); else this.cert.outcome(slug, up);
    }
    this.cert.fold(this.now(), new Set([...this.open, ...this.held].map((p) => p.slug)));
  }

  _close(pos, r) {
    const L = this.ledger, now = this.now();
    this.cert.add({ slug: pos.slug, group: `${pos.asset} ${pos.tf}`, shadow: Boolean(pos.shadow), t: now, end: pos.end, up: pos.sign > 0,
      shares: pos.shares, entry: pos.px, fee0: pos.fee, pnl: r.pnl });
    if (pos.shadow) {
      appendCapped(this.shadowLog, { t: now, slug: pos.slug, a: pos.asset, tf: pos.tf, side: pos.sign > 0 ? "Up" : "Down", bps: pos.bps, j5: pos.recent ?? null, L: pos.L,
        shares: pos.shares, entry: pos.px, exit: r.exitPx, fees: r6(pos.fee + r.exitFee), pnl: r.pnl, how: r.how });
      this._certEvents(now);
      return;
    }
    this._roll(now);
    L.closed += 1;
    if (r.pnl > 0) L.wins += 1;
    L.realized = r6(L.realized + r.pnl);
    L.fees = r6(L.fees + pos.fee + r.exitFee);
    bump(L.hist, now, { settled: 1, wins: r.pnl > 0 ? 1 : 0, pnl: r.pnl, fees: r.exitFee });
    const row = { t: now, slug: pos.slug, tf: pos.tf, side: pos.sign > 0 ? "Up" : "Down", bps: pos.bps, j5: pos.recent ?? null, L: pos.L, shares: pos.shares,
      entry: pos.px, exit: r.exitPx, depth: r.exitDepth, fees: r6(pos.fee + r.exitFee), pnl: r.pnl, how: r.how };
    L.recent.push(row);
    if (L.recent.length > 50) L.recent.splice(0, L.recent.length - 50);
    appendCapped(this.tradeLog, row);
    this._certEvents(now);
  }

  // The kill switch and the verdict of the certificate reach the desk once each.
  _certEvents(now) {
    for (const ev of this.cert.evaluate(now)) {
      try { this.onEvent({ lane: this.type, ...ev }); } catch { /* the journal never stops a lane */ }
    }
  }

  // One journal line per finished hour with trades in it.
  _roll(now) {
    const L = this.ledger, { rows, next } = finishedHours(L.hist, L.emitted, now);
    if (next === L.emitted) return;
    L.emitted = next;
    for (const [h, trades, settled, wins, pnl, fees] of rows) {
      try { this.onEvent({ lane: this.type, hour: new Date(h * HOUR).toISOString(), trades, settled, wins, pnl: r2(pnl), fees: r2(fees) }); } catch { /* the journal never stops a lane */ }
    }
  }

  _persist() {
    try {
      writeJson(this.file, { v: 1, ledger: this.ledger, held: this.held });
      writeJson(this.certFile, this.cert.toJSON());
    } catch { this.error = "agents_lane_store_failed"; }
  }

  // Trades, results and P&L between two times, by the hour.
  period(from, to) { return periodOf(this.ledger.hist, from, to); }

  // A fresh ledger and certificate for a new V2 test: the lane stops first; the trade logs stay as a record.
  reset() {
    this.stop();
    this.ledger = freshLedger(this.now());
    this.cert = new LatCert(null, this.now());
    this.outcomes.clear();
    this.held = [];
    this.open = [];
    this.error = null;
    this._persist();
  }

  status() {
    const now = this.now();
    this._roll(now);
    const L = this.ledger, exposure = this._exposure();
    return {
      type: this.type, running: this.running, error: this.error, trades: L.trades, settled: L.closed, wins: L.wins,
      realized: r2(L.realized), unrealized: 0, pnl: r2(L.realized), dayPnl: this.period(dayStart(now)).pnl, fees: r2(L.fees),
      open: [...this.open, ...this.held].filter((p) => !p.shadow).length, exposure: r2(exposure), dayStopped: this.dayStop === dayStart(now),
      feeds: { ...this.feeds, windows: this.core ? this.core.windows.size : 0 }, recent: L.recent.slice(-10), v2: this.cert.summary(now),
    };
  }
}

// ---- LP rewards: the core (pure, testable) -------------------------------------------------------------------------

// maxDayLossPct: as for the latency lane, off for the V2 test.
const LP_DEFAULTS = Object.freeze({
  pollMs: 10000, k: 1 / 3, tight: 0.25, maxInv: 4, maxDayLossPct: null,
  shield: true, shieldMs: 300000, shieldReactMs: 250, shieldFar: 0.5, shieldVol: 3, shieldWindowMs: 30000,
});
const score = (v, d) => (d >= 0 && d < v - EPS ? ((v - d) / v) ** 2 : 0);
const rnd = (x, t) => Math.round(x / t) * t;
function cutBest(levels, minSize, desc) {
  const a = levels.map((x) => [+x.price, +x.size]).sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]));
  let c = 0;
  for (const [p, s] of a) { c += s; if (c >= minSize) return p; }
  return null;
}
const freshQuoteState = () => ({ bid: null, ask: null, cash: 0, inv: 0, nf: 0, fq: 0, rA: 0, rP: 0, ns: 0, nq: 0 });

class LpCore {
  // universe rows: { cid, tok, tok2, slug, ev, rate ($/day), v (max spread), ms (min size), tick, size (our quote) }
  constructor(universe, params = {}, saved = null, bank = null) {
    this.p = { ...LP_DEFAULTS, ...params };
    // what the markets that left the universe earned: rewards, cash of round trips, fills
    this.bank = bank && [bank.rA, bank.rP, bank.cash, bank.nf].every(finite) ? { ...bank } : { rA: 0, rP: 0, cash: 0, nf: 0 };
    this.rawN = Math.round(600000 / this.p.pollMs);
    this.fvN = Math.max(5, Math.round(60000 / this.p.pollMs));
    this.markets = universe.map((u) => {
      const s = saved && saved[u.cid];
      return { ...u, st: s && s.st ? s.st : freshQuoteState(), mid: s ? s.mid ?? null : null, mk: s ? s.mk ?? null : null,
        raw: s && Array.isArray(s.raw) ? s.raw.slice(-this.rawN) : [], fv: null, shUntil: s ? s.shUntil || 0 : 0, pullAt: 0, tb: [] };
    });
    this.byCid = new Map(this.markets.map((m) => [m.cid, m]));
    this.byEvent = new Map();
    for (const m of this.markets) {
      const k = m.ev || m.cid;
      if (!this.byEvent.has(k)) this.byEvent.set(k, []);
      this.byEvent.get(k).push(m);
    }
    this.shocks = 0;
    this.lastPollAt = null;
  }

  _fill(m, which, q, px, how, now, fills) {
    if (q <= EPS) return;
    const st = m.st;
    st[which].rem -= q;
    if (which === "bid") { st.cash -= q * px; st.inv += q; } else { st.cash += q * px; st.inv -= q; }
    st.nf += 1;
    st.fq += q;
    fills.push({ t: now, cid: m.cid, slug: m.slug, side: which, px: r4(px), q: r2(q), how, mid: m.mid, inv: r2(st.inv) });
  }
  // Quotes pulled by the shield are gone once the reaction time has passed.
  _pull(m, now) {
    if (m.pullAt && now >= m.pullAt) { m.st.bid = null; m.st.ask = null; m.pullAt = 0; }
  }
  _shock(m, now) {
    this.shocks += 1;
    for (const x of this.byEvent.get(m.ev || m.cid) || [m]) {
      if (now >= x.shUntil) x.pullAt = now + this.p.shieldReactMs;
      x.shUntil = Math.max(x.shUntil, now + this.p.shieldMs);
    }
  }

  // An RTDS trade record on either token of a market: fills a resting quote it reaches; may trip the shield.
  // RTDS publishes one record for the taker (average price; the only one with a fee field in fee markets) and one per
  // maker order hit, with the maker's side. A maker record can only reach a quote of ours that crosses the book,
  // so the fills are as for takers only; the shield's one-sided volume, though, sees both sides of every match and
  // in effect trips on total volume. lp_paper.js counts the same way, so the lane and the research variant agree.
  trade({ conditionId, asset, price, side, size }, now) {
    const m = this.byCid.get(conditionId);
    if (!m) return [];
    let px = +price, sd = side;
    const sz = +size;
    if (asset === m.tok2) { px = 1 - px; sd = side === "BUY" ? "SELL" : "BUY"; } else if (asset !== m.tok) return [];
    if (!(sz > 0) || !(px > 0) || !(px < 1)) return [];
    const fills = [], st = m.st;
    this._pull(m, now);
    if (sd === "SELL" && st.bid && st.bid.rem > EPS && px <= st.bid.px + EPS) this._fill(m, "bid", Math.min(st.bid.rem, sz), st.bid.px, "trade", now, fills);
    if (sd === "BUY" && st.ask && st.ask.rem > EPS && px >= st.ask.px - EPS) this._fill(m, "ask", Math.min(st.ask.rem, sz), st.ask.px, "trade", now, fills);
    if (this.p.shield) {
      m.tb.push([now, sd, sz]);
      while (m.tb.length && now - m.tb[0][0] > this.p.shieldWindowMs) m.tb.shift();
      let one = 0;
      for (const x of m.tb) if (x[1] === sd) one += x[2];
      if ((m.mid != null && Math.abs(px - m.mid) >= this.p.shieldFar * m.v - EPS) || one >= this.p.shieldVol * m.size - EPS) this._shock(m, now);
    }
    return fills;
  }

  // One poll: the YES book of every market (Map token -> { bids, asks, tick_size }); returns fills and rewards earned.
  // quote: false marks the books and settles crossings but places no new quotes (the lane's loss stop).
  poll(books, now, { quote = true } = {}) {
    const fills = [];
    let rA = 0, rP = 0;
    const span = this.lastPollAt == null ? this.p.pollMs : Math.min(Math.max(0, now - this.lastPollAt), 2 * this.p.pollMs);
    this.lastPollAt = now;
    for (const m of this.markets) {
      const b = books.get(m.tok);
      if (!b) continue;
      if (b.tick_size) m.tick = +b.tick_size;
      const bids = b.bids || [], asks = b.asks || [];
      const rbb = bids.length ? Math.max(...bids.map((x) => +x.price)) : null, rba = asks.length ? Math.min(...asks.map((x) => +x.price)) : null;
      const bb = cutBest(bids, m.ms, true), ba = cutBest(asks, m.ms, false);
      const mid = bb != null && ba != null ? (bb + ba) / 2 : null;
      m.mid = mid;
      const rawMid = rbb != null && rba != null && rba - rbb <= 2 * m.v + EPS ? (rbb + rba) / 2 : null;
      m.raw.push(rawMid);
      if (m.raw.length > this.rawN) m.raw.shift();
      const rv = m.raw.slice(-this.fvN).filter((x) => x != null).sort((x, y) => x - y);
      const fv = rv.length >= Math.ceil(this.fvN / 2) + 1 && m.raw[m.raw.length - 1] != null ? rv[Math.floor(rv.length / 2)] : null;
      m.fv = fv;
      const r10 = m.raw.filter((x) => x != null), span10 = r10.length ? Math.max(...r10) - Math.min(...r10) : 1;
      let qb = 0, qa = 0;
      if (mid != null) {
        for (const x of bids) { const p = +x.price, s = +x.size; if (s >= m.ms) qb += score(m.v, mid - p) * s; }
        for (const x of asks) { const p = +x.price, s = +x.size; if (s >= m.ms) qa += score(m.v, p - mid) * s; }
      }
      const st = m.st;
      this._pull(m, now);
      // a resting quote the real book now trades through was filled at our price
      if (st.bid && st.bid.rem > EPS && rba != null && rba <= st.bid.px + EPS) this._fill(m, "bid", st.bid.rem, st.bid.px, "cross", now, fills);
      if (st.ask && st.ask.rem > EPS && rbb != null && rbb >= st.ask.px - EPS) this._fill(m, "ask", st.ask.rem, st.ask.px, "cross", now, fills);
      st.bid = null;
      st.ask = null;
      if (!quote) continue;
      if (mid == null || fv == null || Math.abs(mid - fv) > this.p.tight * m.v || span10 > m.v) continue;   // no trustworthy fair value
      if (this.p.shield && now < m.shUntil) continue;                                                          // pulled by the shield
      const ref = mid - (st.inv / (this.p.maxInv * m.size)) * (m.v / 3);                                       // lean against inventory
      const d = this.p.k * m.v, tk = m.tick;
      let bp = Math.floor((ref - d) / tk + EPS) * tk, ap = Math.ceil((ref + d) / tk - EPS) * tk;
      if (mid - bp >= m.v - EPS) bp += tk;
      if (ap - mid >= m.v - EPS) ap -= tk;
      if (rba != null && bp >= rba - EPS) bp = rba - tk;
      if (rbb != null && ap <= rbb + EPS) ap = rbb + tk;
      bp = +rnd(bp, tk).toFixed(4);
      ap = +rnd(ap, tk).toFixed(4);
      if (bp >= tk - EPS && bp < mid && st.inv < this.p.maxInv * m.size - EPS) st.bid = { px: bp, rem: m.size };
      if (ap <= 1 - tk + EPS && ap > mid && st.inv > -this.p.maxInv * m.size + EPS) st.ask = { px: ap, rem: m.size };
      const q1 = st.bid ? score(m.v, mid - st.bid.px) * m.size : 0, q2 = st.ask ? score(m.v, st.ask.px - mid) * m.size : 0;
      const two = mid >= 0.1 && mid <= 0.9;
      const qm = two ? Math.max(Math.min(q1, q2), Math.max(q1, q2) / 3) : Math.min(q1, q2);
      const cA = two ? Math.max(Math.min(qb, qa), Math.max(qb, qa) / 3) : Math.min(qb, qa), cP = qb + qa;
      const per = (m.rate * span) / 86400000;
      if (st.bid || st.ask) st.nq += 1;
      if (qm > EPS) {
        const a = (per * qm) / (qm + cA), p = (per * qm) / (qm + cP);
        st.ns += 1;
        st.rA += a;
        st.rP += p;
        rA += a;
        rP += p;
      }
    }
    for (const m of this.markets) { if (m.fv != null) m.mk = m.fv; else if (m.mid != null && m.mk == null) m.mk = m.mid; }
    return { fills, rA, rP };
  }

  // A stopped lane has no quotes in the books and no fresh prices: both start over when it runs again.
  cancelAll() {
    for (const m of this.markets) {
      m.st.bid = null;
      m.st.ask = null;
      m.raw = [];
      m.fv = null;
      m.pullAt = 0;
      m.tb = [];
    }
    this.lastPollAt = null;
  }

  // Moves a flat market's earnings to the bank (it is leaving the universe).
  retire(m) {
    const st = m.st;
    this.bank.rA = r6(this.bank.rA + st.rA);
    this.bank.rP = r6(this.bank.rP + st.rP);
    this.bank.cash = r6(this.bank.cash + st.cash + (m.mk != null ? st.inv * m.mk : 0));
    this.bank.nf += st.nf;
  }

  totals() {
    let rA = this.bank.rA, rP = this.bank.rP, mtm = this.bank.cash, inv = 0, nf = this.bank.nf, quoting = 0, resting = 0, pulled = 0;
    const now = this.lastPollAt || 0;
    for (const m of this.markets) {
      const st = m.st;
      rA += st.rA;
      rP += st.rP;
      nf += st.nf;
      mtm += st.cash + (m.mk != null ? st.inv * m.mk : 0);
      if (m.mk != null) inv += Math.abs(st.inv) * (st.inv > 0 ? m.mk : 1 - m.mk);
      if (st.bid || st.ask) quoting += 1;
      if (now < m.shUntil) pulled += 1;
      resting += (st.bid ? st.bid.px * st.bid.rem : 0) + (st.ask ? (1 - st.ask.px) * st.ask.rem : 0);
    }
    return { rewardsAgg: r2(rA), rewardsPess: r2(rP), mtm: r2(mtm), inventoryUsd: r2(inv), restingUsd: r2(resting), fills: nf,
      markets: this.markets.length, quoting, pulled, shocks: this.shocks };
  }

  snapshot() {
    const out = {};
    for (const m of this.markets) out[m.cid] = { st: m.st, mid: m.mid, mk: m.mk, raw: m.raw, shUntil: m.shUntil };
    return out;
  }
}

// The reward markets worth quoting with this capital: the research filters (rate >= $5/day, no sports, >= 3 days to
// the end, mid 0.10-0.90, raw spread <= 2v), ranked by expected reward per dollar, taken until the capital is used.
const SPORT = /^(lol|cs2|csgo|dota|val|nfl|nba|nhl|mlb|epl|ucl|uel|atp|wta|ufc|cbb|cfb|mls)-/;
// A failed rewards page is asked again up to twice (after 1 s, then 2 s), a failed books batch once; a refusal that
// cannot change by asking again (an unusable proxy, a wrong proxy login, a 4xx) is not.
const FINAL = /^agents_(proxy_invalid|proxy_auth|http_4\d\d)$/;
async function retried(work, tries, pause) {
  for (let i = 1; ; i += 1) {
    try { return await work(); } catch (error) {
      if (i >= tries || FINAL.test((error && error.code) || "")) throw error;
      await pause(1000 * i);
    }
  }
}
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
async function buildLpUniverse(net, { capitalUsd, perMarketUsd = 50, now = Date.now(), maxMarkets = 300, pause = sleep } = {}) {
  const today = dayKey(now);
  const rateOf = (r) => (r.rewards_config || []).reduce((s, c) => s + ((c.end_date || "9999") >= today && (c.start_date || "0000") <= today ? +c.rate_per_day || 0 : 0), 0);
  let rows = [], cur = null;
  for (let k = 0; k < 40; k += 1) {
    const q = new URLSearchParams({ order_by: "rate_per_day", position: "DESC", page_size: "500" });
    if (cur) q.set("next_cursor", cur);
    const j = await retried(() => net.json(`${CLOB}/rewards/markets/multi?${q}`, { timeout: 30000 }), 3, pause);
    const page = (j && j.data) || [];
    rows.push(...page);
    cur = j && j.next_cursor;
    if (!cur || cur === "LTE=") break;
    // the pages come by rate, highest first: after a page with nothing at $5/day or more, no later page has any
    if (!page.some((r) => r && rateOf(r) >= 5)) break;
  }
  const seen = new Set();
  rows = rows.filter((r) => r && r.condition_id && !seen.has(r.condition_id) && seen.add(r.condition_id));
  for (const r of rows) r.rate = rateOf(r);
  rows = rows.filter((r) => r.rate >= 5 && !SPORT.test(r.market_slug || "") && (r.tokens || []).length === 2);
  rows = rows.filter((r) => { const e = Date.parse(String(r.end_date || "").replace(" ", "T").replace("+00", "Z")); return e && (e - now) / 864e5 >= 3; });
  const books = new Map();
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100);
    try {
      const res = await retried(() => net.json(`${CLOB}/books`, { method: "POST", body: part.map((r) => ({ token_id: r.tokens[0].token_id })), timeout: 30000 }), 2, pause);
      for (const b of res || []) books.set(b.asset_id, b);
    } catch { /* a missing batch only shrinks the choice */ }
  }
  const U = [];
  for (const r of rows) {
    const b = books.get(r.tokens[0].token_id);
    if (!b) continue;
    const v = +r.rewards_max_spread / 100, ms = +r.rewards_min_size, tick = +(b.tick_size || 0.01);
    if (!(v > 0) || !(ms > 0)) continue;
    const bids = b.bids || [], asks = b.asks || [];
    const bb = cutBest(bids, ms, true), ba = cutBest(asks, ms, false);
    if (bb == null || ba == null) continue;
    const mid = (bb + ba) / 2;
    if (mid < 0.1 || mid > 0.9) continue;
    const rbb = Math.max(...bids.map((x) => +x.price)), rba = Math.min(...asks.map((x) => +x.price));
    if (!(rba - rbb <= 2 * v + EPS)) continue;
    const size = Math.max(ms, Math.min(50, perMarketUsd));
    if (size > perMarketUsd + EPS) continue;
    const qb = bids.reduce((s, x) => s + (+x.size >= ms ? score(v, mid - x.price) * x.size : 0), 0);
    const qa = asks.reduce((s, x) => s + (+x.size >= ms ? score(v, x.price - mid) * x.size : 0), 0);
    const qo = Math.max(Math.min(qb, qa), Math.max(qb, qa) / 3);
    const d = Math.max(tick, Math.round(v / 3 / tick) * tick), qu = size * score(v, d), share = qu + qo > 0 ? qu / (qu + qo) : 0;
    const cap = size * (mid - d) + size * (1 - mid - d);
    U.push({ cid: r.condition_id, tok: r.tokens[0].token_id, tok2: r.tokens[1].token_id, slug: r.market_slug, ev: r.event_slug || null,
      rate: r.rate, v, ms, tick, size, end: r.end_date, roc0: r4((r.rate * share) / Math.max(cap, 1)) });
  }
  U.sort((x, y) => y.roc0 - x.roc0);
  const pick = [];
  let used = 0;
  for (const u of U) {
    if (pick.length >= maxMarkets) break;
    if (used + u.size > capitalUsd + EPS) continue;
    pick.push(u);
    used += u.size;
  }
  return pick;
}

// ---- LP rewards: the lane ------------------------------------------------------------------------------------------

// What a market made so far: pessimistic rewards plus the cash of its trades and its inventory at the mark.
const netOf = (m) => m.st.rP + m.st.cash + (m.mk != null ? m.st.inv * m.mk : 0);
// The V2 record of the lane: hours with live books and trades, the two phases, the shield's counts and what the
// markets that left the universe made with the shield (hs, the lane) and without it (h, the shadow).
const freshLpV2 = (now) => ({ since: now, upMs: 0, ph1: null, ph2: null, shocks: 0, pulledMs: 0, marketMs: 0, arch: {} });
const validNets = (x) => Boolean(x) && typeof x === "object" && Object.values(x).every((v) => Array.isArray(v) && v.length === 2 && v.every(finite));
const validPhase = (x) => x === null || (Boolean(x) && typeof x === "object" && finite(x.t) && finite(x.upMs) && validNets(x.nets));
function validLpV2(x) {
  return Boolean(x) && typeof x === "object" && [x.since, x.upMs, x.shocks, x.pulledMs, x.marketMs].every(finite) && validPhase(x.ph1) && validPhase(x.ph2) && validNets(x.arch);
}

class LpLane {
  constructor({ root, net, WebSocketImpl = WS_IMPL, now = () => Date.now(), params = {}, onEvent = () => {}, build = buildLpUniverse, proxy = null } = {}) {
    if (!root) throw new TypeError("root is required");
    this.type = "lp_rewards";
    this.file = path.join(root, "lp.json");
    this.fillLog = path.join(root, "lp-fills.jsonl");
    this.net = net;
    this.WS = WebSocketImpl;
    this.proxy = proxy;
    this.now = now;
    this.onEvent = onEvent;
    this.build = build;
    this.params = { ...LP_DEFAULTS, ...params };
    this.running = false;
    this.error = null;
    this.core = null;
    this.life = new Lifecycle();
    this.rtds = { open: false, msgs: 0, ours: 0, lastAt: null };
    this.busy = false;
    this.retryAt = 0;
    this._restore(readJson(this.file));
  }

  // The saved quotes, inventory and earnings, so the P&L stands while the lane is stopped or the app restarts.
  _restore(saved) {
    const s = saved && typeof saved === "object" ? saved : {};
    this.saved = s;
    this.hist = validHist(s.hist) ? s.hist : [];
    this.emitted = finite(s.emitted) ? s.emitted : Math.floor(this.now() / HOUR);
    this.last = finite(s.last) && finite(s.lastFills) ? { pnl: s.last, fills: s.lastFills } : null;
    this.v2 = validLpV2(s.v2) ? s.v2 : freshLpV2(this.now());
    this.core = null;
    this.shadow = null;
    if (Array.isArray(s.universe) && s.universe.length) {
      try {
        this.core = new LpCore(s.universe, this.params, s.markets || {}, s.bank);
        this.core.cancelAll();
        const h = s.shadow && typeof s.shadow === "object" ? s.shadow : {};
        this.shadow = new LpCore(s.universe, this._shadowParams(), h.markets || {}, h.bank);
        this.shadow.cancelAll();
      } catch { this.core = null; this.shadow = null; }
    }
  }

  // The shadow h: the same quotes without the shield, fed the same books and trades (addendum C).
  _shadowParams() { return { ...(this.p || this.params), shield: false }; }

  start({ capitalUsd = 0, perMarketUsd = 50, params = {} } = {}) {
    if (this.running || this.now() < this.retryAt) return;
    if (typeof this.WS !== "function") { this.error = "agents_lane_no_websocket"; return; }
    if (proxyBlocked(this)) return;
    this.running = true;
    this.error = null;
    this.limits = { capitalUsd, perMarketUsd };
    this.p = { ...this.params, ...params };
    this._universe().then(() => {
      if (!this.running) return;
      this._persist();
      this._rtds();
      this._loop();
      this.life.every(60000, () => this._persist());
      this.life.every(6 * HOUR, () => { this._universe(true).catch(() => {}); });
    }).catch((error) => {
      this.error = error && error.code ? error.code : "agents_lane_universe_failed";
      this.running = false;
      this.retryAt = this.now() + 10 * 60000;   // a failed build is retried in ten minutes, not every tick
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.life.clear();
    if (this.core) this.core.cancelAll();
    if (this.shadow) this.shadow.cancelAll();
    this._persist();
  }

  // A fresh book for "Start afresh"; the fill log stays as a record.
  reset() {
    this.stop();
    try { fs.rmSync(this.file, { force: true }); } catch { /* written over below */ }
    this._restore({});
    this.retryAt = 0;
    this.error = null;
  }

  // The universe is rebuilt at most every 6 hours. A market that drops out keeps quoting while it holds inventory;
  // one that resolved settles its inventory at the result; a flat one moves its earnings to the bank and leaves.
  async _universe(rebuild = false) {
    const s = this.saved || {};
    const fresh = !rebuild && this.core && Array.isArray(s.universe) && s.universe.length && this.now() - (s.builtAt || 0) < 6 * HOUR && s.capitalUsd === this.limits.capitalUsd;
    if (fresh) {
      this.core = new LpCore(s.universe, this.p, this.core.snapshot(), this.core.bank);
      this.shadow = new LpCore(s.universe, this._shadowParams(), this.shadow ? this.shadow.snapshot() : {}, this.shadow ? this.shadow.bank : null);
      return;
    }
    let U = await this.build(this.net, { capitalUsd: this.limits.capitalUsd, perMarketUsd: this.limits.perMarketUsd, now: this.now() });
    const have = new Set(U.map((u) => u.cid));
    const old = this.core ? this.core.markets : [];
    for (const m of old) {
      if (have.has(m.cid)) continue;
      const twin = this.shadow ? this.shadow.byCid.get(m.cid) : null;
      if (Math.abs(m.st.inv) > EPS || (twin && Math.abs(twin.st.inv) > EPS)) {
        const payout = await this._result(m).catch(() => null);
        if (payout == null) { U = U.concat([{ cid: m.cid, tok: m.tok, tok2: m.tok2, slug: m.slug, ev: m.ev, rate: m.rate, v: m.v, ms: m.ms, tick: m.tick, size: m.size }]); continue; }
        if (Math.abs(m.st.inv) > EPS) this._fills([{ t: this.now(), cid: m.cid, slug: m.slug, side: "result", px: payout, q: r2(m.st.inv), how: "result", mid: m.mid, inv: 0 }]);
        for (const x of twin ? [m, twin] : [m]) {
          x.st.cash = r6(x.st.cash + x.st.inv * payout);
          x.st.inv = 0;
          x.mk = payout;
        }
      }
      const a = this.v2.arch[m.cid] || [0, 0];
      this.v2.arch[m.cid] = [r6(a[0] + netOf(m)), r6(a[1] + (twin ? netOf(twin) : 0))];
      this.core.retire(m);
      if (twin) this.shadow.retire(twin);
    }
    if (!U.length) throw fail("agents_lane_no_markets");
    const keep = this.core ? this.core.snapshot() : {};
    const bank = this.core ? this.core.bank : null;
    const keepH = this.shadow ? this.shadow.snapshot() : {};
    const bankH = this.shadow ? this.shadow.bank : null;
    this.core = new LpCore(U, this.p, keep, bank);
    this.shadow = new LpCore(U, this._shadowParams(), keepH, bankH);
    this.saved = { ...s, universe: U, builtAt: this.now(), capitalUsd: this.limits.capitalUsd };
  }

  // The payout of the quoted token if the market has resolved, else null.
  async _result(m) {
    const rows = await this.net.json(`${GAMMA}/markets?condition_ids=${encodeURIComponent(m.cid)}`);
    const g = Array.isArray(rows) ? rows.find((x) => x && x.conditionId === m.cid) : null;
    if (!g || !g.closed) return null;
    const toks = JSON.parse(g.clobTokenIds || "[]"), prices = JSON.parse(g.outcomePrices || "[]");
    const px = +prices[toks.indexOf(m.tok)];
    return px === 0 || px === 1 ? px : null;
  }

  _rtds() {
    if (!this.running) return;
    const ws = openSocket(this, RTDS_WS);
    if (!ws) { this.life.after(5000, () => this._rtds()); return; }
    this.life.sockets.add(ws);
    let last = this.now();
    ws.onopen = () => {
      this.rtds.open = true;
      socketOpened(this);
      last = this.now();
      ws.send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "activity", type: "trades" }] }));
    };
    ws.onmessage = (e) => {
      last = this.now();
      const data = typeof e.data === "string" ? e.data : String(e.data || "");
      if (data[0] !== "{") return;
      let d;
      try { d = JSON.parse(data); } catch { return; }
      if (d.topic !== "activity" || !d.payload) return;
      this.rtds.msgs += 1;
      this.rtds.lastAt = last;
      const p = d.payload;
      if (!this.core || !this.core.byCid.has(p.conditionId)) return;
      this.rtds.ours += 1;
      const trade = { conditionId: p.conditionId, asset: p.asset, price: p.price, side: p.side, size: p.size }, shocks = this.core.shocks;
      this._fills(this.core.trade(trade, last));
      this.v2.shocks += this.core.shocks - shocks;
      if (this.shadow) this.shadow.trade(trade, last);
    };
    ws.onclose = () => {
      this.life.sockets.delete(ws);
      this.rtds.open = false;
      if (this.running) this.life.after(2000, () => this._rtds());
    };
    ws.onerror = (e) => { socketFailed(this, ws, e); try { ws.close(); } catch { /* closing */ } };
    const ping = this.life.every(5000, () => {
      if (!this.life.sockets.has(ws)) { clearInterval(ping); return; }
      if (this.rtds.open) { try { ws.send("PING"); } catch { /* closing */ } }
      if (this.now() - last > 20000) { try { ws.close(); } catch { /* closing */ } }
    });
  }

  _loop() {
    if (!this.running) return;
    const ms = this.p.pollMs;
    this.life.after(ms - (this.now() % ms) + 500, async () => {
      if (!this.busy && this.running) {
        this.busy = true;
        try { await this._poll(); } catch { this.error = "agents_lane_poll_failed"; }
        this.busy = false;
      }
      this._loop();
    });
  }

  async _poll() {
    const toks = this.core.markets.map((m) => m.tok), books = new Map();
    const batches = [];
    for (let i = 0; i < toks.length; i += 100) batches.push(toks.slice(i, i + 100));
    for (let i = 0; i < batches.length; i += 5) {
      const res = await Promise.all(batches.slice(i, i + 5).map((b) =>
        this.net.json(`${CLOB}/books`, { method: "POST", body: b.map((t) => ({ token_id: t })), timeout: 30000 }).catch(() => null)));
      for (const r of res) for (const b of r || []) books.set(b.asset_id, b);
    }
    if (!this.running || !books.size) return;
    const now = this.now();
    const span = this.core.lastPollAt == null ? 0 : Math.min(Math.max(0, now - this.core.lastPollAt), 2 * this.p.pollMs);
    const quote = !this._dayStopped(now);
    const out = this.core.poll(books, now, { quote });
    if (this.shadow) this.shadow.poll(books, now, { quote });
    this._fills(out.fills);
    this._account();
    await this._v2Tick(now, span);
  }

  // The V2 clock: time counts while the books arrive and the trade feed is live. At 24 h the first phase closes
  // (and the shield's test is read on it) and the universe is rebuilt for the second; at 48 h the second closes.
  async _v2Tick(now, span) {
    const v = this.v2, live = this.rtds.open && this.rtds.lastAt != null && now - this.rtds.lastAt < 60000;
    if (!(span > 0)) return;
    const pulled = this.core.markets.filter((m) => now < m.shUntil).length;
    v.marketMs += this.core.markets.length * span;
    v.pulledMs += pulled * span;
    if (!live) return;
    v.upMs += span;
    const PHASE = 24 * HOUR;
    if (!v.ph1 && v.upMs >= PHASE) {
      v.ph1 = { t: now, upMs: v.upMs, nets: this._nets() };
      this._v2Event(now, 1);
      try { await this._universe(true); } catch { /* the 6-hourly rebuild tries again */ }
    } else if (v.ph1 && !v.ph2 && v.upMs >= v.ph1.upMs + PHASE) {
      v.ph2 = { t: now, upMs: v.upMs, nets: this._nets() };
      this._v2Event(now, 2);
    }
  }

  _v2Event(now, phase) {
    const sum = this.v2Summary(now), p = phase === 1 ? sum.phase1 : sum.phase2;
    try {
      this.onEvent({ lane: this.type, op: "v2_phase", phase, ok: p.checks.every((x) => x.ok), net: p.net, topShare: p.topShare,
        shieldT: phase === 1 ? sum.shield.t : null, verdict: sum.verdict });
    } catch { /* the journal never stops a lane */ }
  }

  // Per-market nets { cid: [hs, h] }: the markets in the universe now plus those that left it.
  _nets() {
    const out = {};
    for (const [cid, x] of Object.entries(this.v2.arch)) out[cid] = [x[0], x[1]];
    for (const [core, i] of [[this.core, 0], [this.shadow, 1]]) {
      if (!core) continue;
      for (const m of core.markets) {
        const row = out[m.cid] || (out[m.cid] = [0, 0]);
        row[i] = r6(row[i] + netOf(m));
      }
    }
    return out;
  }

  v2Summary(now = this.now()) {
    const h = this.shadow ? this.shadow.totals() : null, t = this.core ? this.core.totals() : null;
    return lpSummary({ ...this.v2, nets: this._nets(), rewardsHs: t ? t.rewardsPess : null, rewardsH: h ? h.rewardsPess : null }, now);
  }

  // Past the day's loss limit (rewards and marks together) the lane quotes nothing until the next UTC day.
  _dayStopped(now) {
    const pct = (this.p || this.params).maxDayLossPct;
    if (pct == null) return false;
    const limit = (pct / 100) * ((this.limits && this.limits.capitalUsd) || 0);
    if (!(limit > 0)) return false;
    const day = this.period(dayStart(now)).pnl;
    if (day > -limit) return false;
    if (this.dayStop !== dayStart(now)) {
      this.dayStop = dayStart(now);
      try { this.onEvent({ lane: this.type, op: "day_stop", pnl: day, limit: -r2(limit) }); } catch { /* the journal never stops a lane */ }
    }
    return true;
  }

  _fills(fills) { for (const f of fills) appendCapped(this.fillLog, f); }

  // The P&L (pessimistic rewards + marked inventory) moves into the hourly rows as it changes.
  _account() {
    const now = this.now(), t = this.core.totals(), pnl = t.rewardsPess + t.mtm;
    if (this.last) bump(this.hist, now, { trades: t.fills - this.last.fills, pnl: pnl - this.last.pnl });
    this.last = { pnl, fills: t.fills };
    const { rows, next } = finishedHours(this.hist, this.emitted, now);
    if (next === this.emitted) return;
    this.emitted = next;
    for (const [h, fills, , , hourPnl] of rows) {
      try { this.onEvent({ lane: this.type, hour: new Date(h * HOUR).toISOString(), trades: fills, pnl: r2(hourPnl), quoting: t.quoting, pulled: t.pulled }); } catch { /* the journal never stops a lane */ }
    }
  }

  _persist() {
    if (!this.core) return;
    try {
      this.saved = { ...(this.saved || {}), v: 1, markets: this.core.snapshot(), bank: this.core.bank, hist: this.hist, emitted: this.emitted,
        last: this.last ? this.last.pnl : null, lastFills: this.last ? this.last.fills : null,
        shadow: this.shadow ? { markets: this.shadow.snapshot(), bank: this.shadow.bank } : null, v2: this.v2 };
      writeJson(this.file, this.saved);
    } catch { this.error = "agents_lane_store_failed"; }
  }

  period(from, to) { return periodOf(this.hist, from, to); }

  status() {
    const t = this.core ? this.core.totals() : null;
    const today = dayStart(this.now());
    const base = { type: this.type, running: this.running, error: this.error, settled: 0, wins: 0, dayPnl: this.period(today).pnl, dayStopped: this.dayStop === today };
    if (!t) return { ...base, trades: 0, realized: 0, unrealized: 0, pnl: 0, open: 0, exposure: 0, v2: this.v2Summary() };
    const h = this.shadow ? this.shadow.totals() : null;
    return {
      ...base, trades: t.fills, realized: t.rewardsPess, unrealized: t.mtm, pnl: r2(t.rewardsPess + t.mtm), rewardsAgg: t.rewardsAgg, rewardsPess: t.rewardsPess,
      open: t.quoting, exposure: r2(t.restingUsd + t.inventoryUsd), markets: t.markets, quoting: t.quoting, pulled: t.pulled, shocks: t.shocks,
      rtds: { ...this.rtds }, lastPollAt: this.core.lastPollAt,
      shadow: h ? { pnl: r2(h.rewardsPess + h.mtm), rewardsPess: h.rewardsPess, mtm: h.mtm, fills: h.fills } : null, v2: this.v2Summary(),
    };
  }
}

const LANE_TYPES = Object.freeze(["latency", "lp_rewards"]);
function createLanes({ root, net, WebSocketImpl, now, onEvent, proxy = null } = {}) {
  return {
    latency: new LatencyLane({ root, net, WebSocketImpl, now, onEvent, proxy }),
    lp_rewards: new LpLane({ root, net, WebSocketImpl, now, onEvent, proxy }),
  };
}

module.exports = { LatencyCore, LatencyLane, LpCore, LpLane, buildLpUniverse, createLanes, LANE_TYPES, LAT_DEFAULTS, LP_DEFAULTS, cutBest };
