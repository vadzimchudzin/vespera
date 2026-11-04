"use strict";

/* Vespera data collector (V2 M0): records around the clock what the backtester and the fair-value model need.
 * Streams (see store.js for the files):
 *   clob          Polymarket CLOB market channel as sent (minus order-book hashes): book, price_change,
 *                 last_trade_price, tick_size_change, best_bid_ask, new_market, market_resolved; for the current and
 *                 next window of every series and 5 min after a window ends (BTC/ETH/SOL/XRP × 5m, 15m, 1h, 4h, 1d);
 *                 the series are split over clobShards sockets
 *   chainlink     RTDS Chainlink price and TWAP-60 of the same assets; after every connect also ~1 min of history
 *   fills         RTDS activity: every fill on those markets (side, price, size, wallet, fee, transaction)
 *   binance       Binance aggTrade; binance-book: bookTicker on every change of a best price, size-only changes at
 *                 most every bookSampleMs. From Binance.US (the last fallback, another exchange) they go to binanceus and
 *                 binanceus-book instead.
 *   meta          series and windows from Gamma: tokens, start, end, fee schedule, tick, minimum size, rewards, the
 *                 resolution rule and source, priceToBeat/finalPrice, the official result (a line per change)
 *   events        start, stop, connects and disconnects, gaps, subscriptions, health once a minute
 * Gaps are kept per feed (clob, chainlink, binance; the CLOB per socket, with its shard): no message for gapMs, a
 * disconnect, or the time the collector was down (from state.json at the next start). They go to the events stream
 * and the day's manifest. */
const fs = require("node:fs");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { Store, utcDay } = require("./store");
const { Socket } = require("./socket");
const { Windows, ASSETS, TFS } = require("./windows");

const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const RTDS_WS = "wss://ws-live-data.polymarket.com";
const BINANCE = [
  { id: "com", base: "wss://stream.binance.com:9443" },
  { id: "vision", base: "wss://data-stream.binance.vision" },
  { id: "us", base: "wss://stream.binance.us:9443" },
];
const FEEDS = ["clob", "chainlink", "binance"];
const STATE = "state.json";
const LOCK = "collector.lock";
const VERSION = (() => { try { return require("../../package.json").version; } catch { return null; } })();

const parse = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };
const stripHashes = (raw) => raw.replace(/,\s*"hash"\s*:\s*"[^"]*"/g, "").replace(/\{\s*"hash"\s*:\s*"[^"]*"\s*,/g, "{");
const codeOf = (e) => (e && (e.code || e.name || e.message)) || String(e);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

class Collector {
  constructor({ dir, assets = ASSETS, tfs = TFS, gapMs = 5000, bookSampleMs = 250, clobShards = 4, fetch: fetchFn = globalThis.fetch,
    WebSocket: WS = globalThis.WebSocket, now = Date.now, log = () => {}, binance = BINANCE, timers = true, healthMs = 60000, stateMs = 10000,
    httpTimeoutMs = 15000 } = {}) {
    if (!dir) throw new Error("collector_dir_missing");
    this.dir = path.resolve(dir);
    Object.assign(this, { assets: assets.map((a) => String(a).toLowerCase()), tfs, gapMs, bookSampleMs, fetchFn, WS, now, log, binanceEndpoints: binance, timers, healthMs, stateMs, httpTimeoutMs });
    this.store = new Store({ dir: this.dir, log: (level, msg) => this.log(level, msg) });
    this.windows = new Windows({ fetchJson: (url) => this._json(url), now, assets: this.assets, tfs,
      onWindow: (w) => this._write("meta", { kind: "window", ...w }),
      onSeries: (s) => this._write("meta", { kind: "series", ...s }),
      onError: (e) => this._event("error", { where: "gamma", code: codeOf(e) }) });
    this.feeds = Object.fromEntries(FEEDS.map((f) => [f, { last: null, gap: null, n: 0, gaps: 0, over: 0, endpoint: null }]));
    // CLOB shards: series dealt round-robin in asset-major order, so each socket gets a mix of assets and timeframes.
    const n = Math.max(1, Math.min(Math.floor(Number(clobShards)) || 1, this.windows.series.length));
    this.shardOf = new Map(this.windows.series.map((x, k) => [`${x.asset}|${x.tf}`, k % n]));
    this.shards = Array.from({ length: n }, (_, i) => ({ i, socket: null, subscribed: new Set(), last: null, gap: null,
      series: this.windows.series.filter((x, k) => k % n === i).map((x) => `${x.asset}-${x.tf}`) }));
    this.symbols = new Set(this.assets.map((a) => `${a}/usd`));
    this.conds = new Set();
    this.bookLast = new Map();
    this.bad = { clob: 0, rtds: 0, binance: 0 };
    this.running = false;
    this.abort = new AbortController();
    this.healthAt = 0;
    this.stateAt = 0;
    this.linesPrev = {};
    this.cpuPrev = null;
  }

  async start() {
    if (this.running) return this;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o750 });
    this._lock();
    try {
      await this.store.open();
    } catch (e) {
      this._unlock();
      throw e;
    }
    const t = this.now();
    this.started = t;
    this.healthAt = t;
    this.stateAt = t;
    this.cpuPrev = process.cpuUsage();
    if (this.timers) { this.loop = monitorEventLoopDelay({ resolution: 10 }); this.loop.enable(); }
    const prev = this._readState();
    for (const f of FEEDS) {
      const last = prev && prev.feeds && prev.feeds[f] && prev.feeds[f].last;
      if (Number.isFinite(last) && last < t) Object.assign(this.feeds[f], { last, gap: { kind: "down", from: last } });
    }
    this.running = true;
    this._event("start", { pid: process.pid, version: VERSION, assets: this.assets, tfs: this.tfs, gapMs: this.gapMs, bookSampleMs: this.bookSampleMs,
      clobShards: this.shards.map((x) => x.series),
      previous: prev ? { started: prev.started ?? null, at: prev.at ?? null, stopped: prev.stopped ?? null } : null });
    // RTDS sends Chainlink points for every symbol each second: 4 s of nothing is a stalled socket, not a quiet market.
    this.rtds = new Socket({ name: "rtds", endpoints: [{ id: "polymarket", url: RTDS_WS }], WebSocket: this.WS, now: this.now, ping: "PING", pingMs: 5000, idleMs: 4000,
      onOpen: (send) => {
        send({ action: "subscribe", subscriptions: [{ topic: "activity", type: "trades" },
          { topic: "crypto_prices_chainlink", type: "*", filters: "" }, { topic: "crypto_prices_twap_sixty", type: "*", filters: "" }] });
        this._history();
      },
      onMessage: (raw) => this._rtds(raw), onStatus: (st, ep, info) => this._status("rtds", st, ep, info) }).start();
    const streams = this.assets.flatMap((a) => [`${a}usdt@aggTrade`, `${a}usdt@bookTicker`]).join("/");
    this.binance = new Socket({ name: "binance", endpoints: this.binanceEndpoints.map((e) => ({ id: e.id, url: `${e.base}/stream?streams=${streams}` })),
      WebSocket: this.WS, now: this.now, ping: null, idleMs: 15000,
      onMessage: (raw, ep) => this._binance(raw, ep), onStatus: (st, ep, info) => this._status("binance", st, ep, info) }).start();
    this.windows.step(t);
    this._writeState(t);
    if (this.timers) this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log("error", `tick: ${codeOf(e)}`); } }, 1000);
    return this;
  }

  tick(t = this.now()) {
    if (!this.running) return;
    for (const s of this._sockets()) s.tick(t);
    if (this.history && t > this.historyUntil) this._historyDone();
    for (const [name, f] of Object.entries(this.feeds)) if (name !== "clob" && !f.gap && f.last != null && t - f.last > this.gapMs) f.gap = { kind: "silence", from: f.last };
    for (const sh of this.shards) if (!sh.gap && sh.last != null && t - sh.last > this.gapMs) sh.gap = { kind: "silence", from: sh.last };
    this.conds = this.windows.conditions();
    this._books(t);
    this.windows.step(t);
    this.store.tick(t);
    if (t - this.healthAt >= this.healthMs) this._health(t);
    if (t - this.stateAt >= this.stateMs) this._writeState(t);
  }

  async stop() {
    if (!this.running) return;
    const t = this.now();
    this.running = false;
    clearInterval(this.timer);
    if (this.loop) this.loop.disable();
    for (const s of this._sockets()) s.close();
    this.abort.abort();
    try { await this.windows.busy; } catch {}
    this.store.write("events", t, { ev: "stop", feeds: this._feedStatus(t), written: { ...this.store.written } });
    await this.store.close();
    this._writeState(t, true);
    this._unlock();
  }

  status(t = this.now()) {
    return { running: this.running, started: this.started || null, at: t, feeds: this._feedStatus(t), windows: this.windows.status(t), tokens: this._tokens(),
      store: this.store.status(), bad: { ...this.bad } };
  }

  // --- sources -------------------------------------------------------------------------------------------------------

  // CLOB: the recorded tokens are split over a few sockets by series. Polymarket drops a busy socket with 1013 "slow
  // consumer" far more often than several lighter ones (measured: 3 drops of one socket for 80 tokens in 4 min against
  // none of four for 20 each), and a drop then costs only a part of the markets. Each set follows its windows
  // (subscribe/unsubscribe on the open socket); a PING every 2 s keeps a quiet socket answering.
  _books(t) {
    for (const sh of this.shards) {
      const pick = (w) => (this.shardOf.get(`${w.asset}|${w.tf}`) ?? 0) === sh.i;
      const want = this.windows.tokens(t, pick);
      if (!sh.socket) {
        if (!want.size) continue;
        sh.socket = new Socket({ name: `clob${sh.i}`, endpoints: [{ id: "polymarket", url: CLOB_WS }], WebSocket: this.WS, now: this.now, ping: "PING", pingMs: 2000,
          idleMs: 5000,
          onOpen: (send) => {
            sh.subscribed = new Set(this.windows.tokens(this.now(), pick));
            send({ assets_ids: [...sh.subscribed], type: "market", custom_feature_enabled: true });
            this._event("subscribe", { shard: sh.i, add: sh.subscribed.size, drop: 0, total: sh.subscribed.size });
          },
          onMessage: (raw) => this._clob(raw, sh), onStatus: (st, ep, info) => this._status("clob", st, ep, info, sh) }).start();
        continue;
      }
      if (!sh.socket.open) continue;
      const add = [...want].filter((x) => !sh.subscribed.has(x)), drop = [...sh.subscribed].filter((x) => !want.has(x));
      if (add.length && sh.socket.send({ assets_ids: add, operation: "subscribe", custom_feature_enabled: true })) add.forEach((x) => sh.subscribed.add(x));
      if (drop.length && sh.socket.send({ assets_ids: drop, operation: "unsubscribe" })) drop.forEach((x) => sh.subscribed.delete(x));
      if (add.length || drop.length) this._event("subscribe", { shard: sh.i, add: add.length, drop: drop.length, total: sh.subscribed.size });
    }
  }

  _sockets() { return [this.rtds, this.binance, this.history, ...this.shards.map((x) => x.socket)].filter(Boolean); }

  _tokens() { return this.shards.reduce((a, x) => a + x.subscribed.size, 0); }

  // Stored as received minus the per-level order-book hashes: random hex that made up ~60% of the compressed CLOB data
  // and is of no use offline (a transaction_hash stays). No parse: this is by far the busiest stream.
  _clob(raw, sh) {
    const t = this.now();
    this._seen("clob", t, sh);
    const text = stripHashes(raw).trim();
    if (!/^[[{][\s\S]*[\]}]$/.test(text)) { this.bad.clob += 1; return; }
    this.store.writeRaw("clob", t, text);
  }

  _rtds(raw) {
    const t = this.now();
    const d = parse(raw);
    if (!d || typeof d !== "object") { if (d === undefined) this.bad.rtds += 1; return; }
    const p = d.payload;
    if (!p || typeof p !== "object") return;
    if ((d.topic === "crypto_prices_chainlink" || d.topic === "crypto_prices_twap_sixty") && this.symbols.has(String(p.symbol || "").toLowerCase())) {
      delete d.connection_id;
      this._seen("chainlink", t);
      this.store.write("chainlink", t, d);
    } else if (d.topic === "activity" && this.conds.has(String(p.conditionId || ""))) {
      delete d.connection_id;
      this.store.write("fills", t, d);
    }
  }

  // ~1 min of Chainlink history after each RTDS connect (a filtered subscribe answers with it), on a short-lived socket:
  // a short disconnect then loses no Chainlink points.
  _history() {
    if (this.history || !this.running) return;
    const subs = [...this.symbols].flatMap((symbol) => [
      { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol }) },
      { topic: "crypto_prices_twap_sixty", type: "*", filters: JSON.stringify({ symbol }) }]);
    let got = 0;
    this.historyUntil = this.now() + 20000;
    this.history = new Socket({ name: "history", endpoints: [{ id: "polymarket", url: RTDS_WS }], WebSocket: this.WS, now: this.now, ping: "PING", pingMs: 5000, idleMs: 0,
      onOpen: (send) => send({ action: "subscribe", subscriptions: subs }),
      onMessage: (raw) => {
        const d = parse(raw), p = d && d.payload;
        if (!p || !Array.isArray(p.data) || !this.symbols.has(String(p.symbol || "").toLowerCase())) return;
        delete d.connection_id;
        this.store.write("chainlink", this.now(), d);
        if (++got >= subs.length) this._historyDone();
      } }).start();
  }

  _historyDone() {
    if (!this.history) return;
    this.history.close();
    this.history = null;
  }

  _binance(raw, ep) {
    const t = this.now();
    const m = parse(raw), d = m && m.data;
    if (!d || typeof d !== "object") { if (m === undefined) this.bad.binance += 1; return; }
    this._seen("binance", t);
    const name = ep === "us" ? "binanceus" : "binance";
    if (d.e === "aggTrade") this.store.write(name, t, d);
    else if (d.u != null && d.s && d.b != null && d.a != null) {
      const prev = this.bookLast.get(d.s);
      if (!prev || prev.b !== d.b || prev.a !== d.a || t - prev.t >= this.bookSampleMs) {
        this.bookLast.set(d.s, { b: d.b, a: d.a, t });
        this.store.write(`${name}-book`, t, d);
      }
    }
  }

  // --- gaps, events, state -------------------------------------------------------------------------------------------

  // sh: the CLOB shard the socket serves (its gaps are its own: the other shards' markets are still recorded).
  _status(socket, st, ep, info = null, sh = null) {
    const feed = socket === "rtds" ? "chainlink" : socket, f = this.feeds[feed], t = this.now(), tr = sh || f;
    if (st === "open") {
      f.endpoint = ep;
      this.store.noteEndpoint(utcDay(t), socket, ep);
      if (socket === "binance") this.bookLast.clear();
    } else if ((st === "close" || st === "silent") && !tr.gap) {
      tr.gap = { kind: st === "silent" ? "silence" : "disconnect", from: tr.last != null ? tr.last : t };
    }
    if (sh && st !== "open") sh.subscribed = new Set();
    if (st !== "connecting") this._event(st, { socket, ...(sh ? { shard: sh.i } : {}), endpoint: ep, ...(info || {}) });
  }

  _seen(feed, t, sh = null) {
    const f = this.feeds[feed], tr = sh || f;
    if (sh && f.gap) this._gapEnd(feed, f, t);   // the time the collector was down is one gap of the whole feed
    if (!tr.gap && tr.last != null && t - tr.last > this.gapMs) tr.gap = { kind: "silence", from: tr.last };
    if (tr.gap) this._gapEnd(feed, tr, t, sh);
    tr.last = t;
    f.last = t;
    f.n += 1;
  }

  _gapEnd(feed, tr, t, sh = null) {
    const f = this.feeds[feed];
    const gap = { feed, ...(sh ? { shard: sh.i } : {}), kind: tr.gap.kind, from: tr.gap.from, to: t, ms: t - tr.gap.from };
    tr.gap = null;
    f.gaps += 1;
    if (gap.ms > this.gapMs) f.over += 1;
    this.store.addGap(gap);
    this._event("gap", gap);
    if (gap.ms > this.gapMs) this.log("warn", `gap ${feed}${sh ? ` #${sh.i}` : ""} ${gap.kind} ${(gap.ms / 1000).toFixed(1)} s`);
  }

  _feedStatus(t) {
    const out = {};
    for (const [name, f] of Object.entries(this.feeds)) {
      out[name] = { last: f.last, age: f.last == null ? null : t - f.last, endpoint: f.endpoint, messages: f.n, gaps: f.gaps, over: f.over,
        gap: f.gap ? { kind: f.gap.kind, from: f.gap.from } : null };
    }
    out.clob.shards = this.shards.map((x) => ({ shard: x.i, series: x.series, open: !!(x.socket && x.socket.open), tokens: x.subscribed.size, last: x.last,
      gap: x.gap ? { kind: x.gap.kind, from: x.gap.from } : null }));
    if (!out.clob.gap) {
      const open = this.shards.filter((x) => x.gap).sort((a, b) => a.gap.from - b.gap.from)[0];
      if (open) out.clob.gap = { kind: open.gap.kind, from: open.gap.from, shard: open.i };
    }
    return out;
  }

  _write(stream, d) { if (this.running) this.store.write(stream, this.now(), d); }

  _event(ev, data = {}) { this._write("events", { ev, ...data }); }

  _health(t) {
    const mem = process.memoryUsage(), cpu = process.cpuUsage(this.cpuPrev);
    this.cpuPrev = process.cpuUsage();
    const written = this.store.written, lines = {};
    for (const [k, v] of Object.entries(written)) lines[k] = v - (this.linesPrev[k] || 0);
    this.linesPrev = { ...written };
    this._event("health", { periodMs: t - this.healthAt, rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000), lines, tokens: this._tokens(), windows: this.windows.status(t), storeErrors: this.store.errors,
      bad: { ...this.bad }, loop: this._loop() });
    this.healthAt = t;
  }

  // Event-loop delay since the last health line: a stalled loop leaves the sockets unread and the servers drop us.
  _loop() {
    if (!this.loop) return null;
    const out = { p99Ms: Math.round(this.loop.percentile(99) / 1e6), maxMs: Math.round(this.loop.max / 1e6) };
    this.loop.reset();
    return out;
  }

  _readState() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, STATE), "utf8")); } catch { return null; }
  }

  _writeState(t, stopped = false) {
    this.stateAt = t;
    try {
      writeJson(path.join(this.dir, STATE), { pid: process.pid, version: VERSION, started: this.started || null, at: t, stopped: stopped ? t : null,
        feeds: this._feedStatus(t), windows: this.windows.status(t), tokens: this._tokens(), store: this.store.status(), bad: { ...this.bad } });
    } catch (e) {
      this.log("error", `state: ${codeOf(e)}`);
    }
  }

  _lock() {
    const file = path.join(this.dir, LOCK);
    try {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (pid && pid !== process.pid && alive(pid)) {
        const err = new Error("collector_running");
        err.code = "collector_running";
        err.pid = pid;
        throw err;
      }
    } catch (e) {
      if (e.code === "collector_running") throw e;
    }
    fs.writeFileSync(file, String(process.pid), { mode: 0o640 });
    this.locked = true;
  }

  _unlock() {
    if (!this.locked) return;
    this.locked = false;
    try {
      if (Number(fs.readFileSync(path.join(this.dir, LOCK), "utf8")) === process.pid) fs.rmSync(path.join(this.dir, LOCK), { force: true });
    } catch {}
  }

  async _json(url) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.httpTimeoutMs)]);
    const r = await this.fetchFn(url, { signal, headers: { accept: "application/json" } });
    if (!r.ok) {
      const err = new Error(`gamma_http_${r.status}`);
      err.code = `gamma_http_${r.status}`;
      throw err;
    }
    return r.json();
  }
}

module.exports = { Collector, stripHashes, CLOB_WS, RTDS_WS, BINANCE, FEEDS, STATE, LOCK };
