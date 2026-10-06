"use strict";

const https = require("https");
const { INTERVAL_MS, HISTORY_BARS } = require("./markets");

let WebSocketImpl = null;
try {
  WebSocketImpl = require("ws");
} catch {
  WebSocketImpl = null;
}

function defaultFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Vespera/0.3" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function parseKlines(raw) {
  if (!Array.isArray(raw)) {
    throw new Error(`klines_not_array: ${typeof raw}`);
  }
  return raw.map((row) => ({
    openTs: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTs: Number(row[6]),
    closed: true,
  }));
}

const KLINE_HOSTS = ["https://api.binance.com", "https://api.binance.us"];

function wsUrl(host, symbol, timeframe) {
  const s = String(symbol || "BTCUSDT").toLowerCase();
  const tf = String(timeframe || "15m");
  return `${host}/stream?streams=${s}@kline_${tf}/${s}@aggTrade`;
}

const WS_HOSTS = [
  "wss://data-stream.binance.vision",
  "wss://stream.binance.com:443",
  "wss://stream.binance.us:9443",
  "wss://stream.binance.com:9443",
];

function clampRefreshMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(2000, Math.max(1, Math.round(n)));
}

class MarketData {
  constructor({ symbol = "BTCUSDT", timeframe = "15m", fetchJson, refreshMs = 100, webSocketImpl = WebSocketImpl, wsConnectTimeoutMs = 15_000 } = {}) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.fetchJson = fetchJson || defaultFetchJson;
    this.WebSocketImpl = webSocketImpl;
    this.wsConnectTimeoutMs = wsConnectTimeoutMs;
    this.refreshMs = clampRefreshMs(refreshMs);
    this.bars = [];
    this.forming = null;
    this.listeners = new Set();
    this.timer = null;
    this.ws = null;
    this._busy = false;
    this._wsIndex = 0;
    this._lastTickEmit = 0;
    this._wanted = false;
    this._reconnectTimer = null;
    this._lastWsAt = 0;
    this._wsGeneration = 0;
    this._pingTimer = null;
    this._wsConnectTimer = null;
    this._lifecycleGeneration = 0;
    this._historyRequest = 0;
    this._wsClosedBars = new Map();
    this._wsSignalledBars = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onBar(fn) {
    return this.on(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners) fn(event, payload);
  }

  _emitHealth(state, details = {}) {
    this.emit("health", {
      state,
      at: Date.now(),
      symbol: this.symbol,
      timeframe: this.timeframe,
      ...details,
    });
  }

  setRefreshMs(ms) {
    this.refreshMs = clampRefreshMs(ms);
  }

  async configure({ symbol, timeframe, refreshMs, emitHistory = true } = {}) {
    const previous = {
      symbol: this.symbol, timeframe: this.timeframe, refreshMs: this.refreshMs,
      bars: this.bars, forming: this.forming,
      closedBars: new Map(this._wsClosedBars), signalledBars: new Set(this._wsSignalledBars),
    };
    if (refreshMs != null) this.setRefreshMs(refreshMs);
    const nextSymbol = symbol || this.symbol;
    const nextTf = timeframe || this.timeframe;
    const changed = nextSymbol !== this.symbol || nextTf !== this.timeframe;
    this.symbol = nextSymbol;
    this.timeframe = nextTf;
    if (!changed) return this.bars;
    this.bars = [];
    this.forming = null;
    this._wsClosedBars.clear();
    this._wsSignalledBars.clear();
    const keep = this._wanted;
    this.stop({ keepWanted: keep });
    const generation = this._lifecycleGeneration;
    try {
      await this.loadHistory(HISTORY_BARS, { emitHistory });
    } catch (error) {
      if (generation === this._lifecycleGeneration) {
        this.symbol = previous.symbol;
        this.timeframe = previous.timeframe;
        this.refreshMs = previous.refreshMs;
        this.bars = previous.bars;
        this.forming = previous.forming;
        this._wsClosedBars = previous.closedBars;
        this._wsSignalledBars = previous.signalledBars;
      }
      throw error;
    } finally {
      if (generation === this._lifecycleGeneration && keep) this.start();
    }
    return this.bars;
  }

  async _fetchKlinesPage(limit, endTime, symbol = this.symbol, timeframe = this.timeframe) {
    let raw;
    let lastErr;
    const cap = Math.min(1000, Math.max(1, limit));
    for (const host of KLINE_HOSTS) {
      let url = `${host}/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${cap}`;
      if (endTime) url += `&endTime=${endTime}`;
      try {
        raw = await this.fetchJson(url);
        if (Array.isArray(raw)) return raw;
        lastErr = new Error(`klines_not_array from ${host}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("klines_failed");
  }

  async loadHistory(limit = HISTORY_BARS, { emitHistory = true } = {}) {
    const want = Math.min(HISTORY_BARS, Math.max(200, Number(limit) || HISTORY_BARS));
    const generation = this._lifecycleGeneration;
    const request = ++this._historyRequest;
    const symbol = this.symbol;
    const timeframe = this.timeframe;
    let pages = [];
    let endTime = null;
    while (pages.length < want) {
      const remaining = want - pages.length;
      const raw = await this._fetchKlinesPage(remaining, endTime, symbol, timeframe);
      if (generation !== this._lifecycleGeneration || request !== this._historyRequest) return this.bars;
      if (!Array.isArray(raw) || !raw.length) break;
      pages = raw.concat(pages);
      if (raw.length < Math.min(1000, remaining)) break;
      const firstOpen = Number(raw[0][0]);
      if (!Number.isFinite(firstOpen)) break;
      endTime = firstOpen - 1;
      if (pages.length >= want) break;
    }
    const seen = new Set();
    const unique = [];
    for (const row of pages) {
      const ts = Number(row[0]);
      if (seen.has(ts)) continue;
      seen.add(ts);
      unique.push(row);
    }
    unique.sort((a, b) => Number(a[0]) - Number(b[0]));
    const raw = unique.slice(-want);
    const history = new Map(parseKlines(raw).map((bar) => [bar.openTs, bar]));
    for (const bar of this.bars) if (!history.has(bar.openTs)) history.set(bar.openTs, bar);
    for (const [openTs, bar] of this._wsClosedBars) history.set(openTs, bar);
    const interval = INTERVAL_MS[timeframe] || 900_000;
    const ordered = [...history.values()].sort((a, b) => a.openTs - b.openTs).slice(-want);
    const last = ordered[ordered.length - 1];
    let forming = null;
    let closedBars = ordered;
    if (last && last.closeTs >= Date.now() && !this._wsClosedBars.has(last.openTs)) {
      last.closed = false;
      forming = last;
      closedBars = ordered.slice(0, -1);
    }
    const liveForming = this.forming;
    if (liveForming && !this._wsClosedBars.has(liveForming.openTs) && (!forming || liveForming.openTs >= forming.openTs)) {
      forming = liveForming;
    }
    this.forming = forming;
    this.bars = closedBars;
    this._trimBars();
    if (emitHistory) {
      this.emit("history", { bars: this.bars, forming: this.forming });
    }
    return this.bars;
  }

  start() {
    this._wanted = true;
    this.stop({ keepWanted: true });
    const reconcile = async () => {
      if (this._busy) return;
      this._busy = true;
      const generation = this._lifecycleGeneration;
      try {
        const staleWs = this.ws && this._lastWsAt && Date.now() - this._lastWsAt > 90_000;
        if (staleWs) {
          this._safeClose(this.ws);
          this.ws = null;
          this._emitHealth("reconnecting", { reason: "stale" });
        }
        const prevTs = this.bars.length ? this.bars[this.bars.length - 1].openTs : null;
        const liveForming = this.forming && this.ws ? { ...this.forming } : null;
        await this.loadHistory(HISTORY_BARS, { emitHistory: true });
        if (generation !== this._lifecycleGeneration) return;
        if (liveForming) {
          if (this.forming && this.forming.openTs === liveForming.openTs) {
            this.forming.close = liveForming.close;
            this.forming.high = Math.max(this.forming.high, liveForming.high);
            this.forming.low = Math.min(this.forming.low, liveForming.low);
          } else if (!this.forming) {
            this.forming = liveForming;
          }
        }
        this._emitReconciledClose(prevTs);
        this._emitTick(true);
        if (!this.ws && this._wanted) this._openWs();
      } catch (err) {
        if (generation === this._lifecycleGeneration) this.emit("error", String(err.message || err));
      } finally {
        this._busy = false;
      }
    };
    if (this.bars.length === 0) reconcile();
    this.timer = setInterval(reconcile, 15000);
    this._openWs();
  }

  stop({ keepWanted = false } = {}) {
    this._lifecycleGeneration += 1;
    this._historyRequest += 1;
    this._wsGeneration += 1;
    if (!keepWanted) this._wanted = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._wsConnectTimer) {
      clearTimeout(this._wsConnectTimer);
      this._wsConnectTimer = null;
    }
    if (this.ws) {
      this._safeClose(this.ws);
      this.ws = null;
    }
  }

  _safeClose(ws) {
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.on("error", () => {});
    } catch {
      /* ignore */
    }
    try {
      const connecting = this.WebSocketImpl && ws.readyState === this.WebSocketImpl.CONNECTING;
      const open = this.WebSocketImpl && ws.readyState === this.WebSocketImpl.OPEN;
      if (connecting && typeof ws.terminate === "function") {
        ws.terminate();
      } else if (open) {
        ws.close();
      } else if (typeof ws.terminate === "function") {
        ws.terminate();
      }
    } catch {
      /* ws throws if close() runs before the handshake — ignore */
    }
  }

  _openWs() {
    if (!this.WebSocketImpl || !this._wanted) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this._safeClose(this.ws);
      this.ws = null;
    }
    const host = WS_HOSTS[this._wsIndex % WS_HOSTS.length];
    const url = wsUrl(host, this.symbol, this.timeframe);
    const generation = (this._wsGeneration += 1);
    this._emitHealth("connecting", { host });
    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (err) {
      this.emit("error", String(err.message || err));
      this._scheduleReconnect();
      this._emitHealth("reconnecting", { host, reason: "connect_error" });
      return;
    }
    this.ws = ws;
    this._lastWsAt = Date.now();
    this._wsConnectTimer = setTimeout(() => {
      if (this._wsGeneration !== generation || this.ws !== ws) return;
      this._wsConnectTimer = null;
      this._safeClose(ws);
      this.ws = null;
      if (this._pingTimer) clearInterval(this._pingTimer);
      this._pingTimer = null;
      this._scheduleReconnect();
      this._emitHealth("reconnecting", { host, reason: "connect_timeout" });
    }, this.wsConnectTimeoutMs);
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._pingTimer = setInterval(() => {
      if (!this.ws || this.ws !== ws) return;
      try {
        if (typeof ws.ping === "function") ws.ping();
      } catch {
        this._safeClose(ws);
        if (this.ws === ws) this.ws = null;
        this._scheduleReconnect();
        this._emitHealth("reconnecting", { host, reason: "ping_error" });
      }
    }, 20_000);
    ws.on("open", () => {
      if (this._wsGeneration !== generation || this.ws !== ws) return;
      if (this._wsConnectTimer) clearTimeout(this._wsConnectTimer);
      this._wsConnectTimer = null;
      this._lastWsAt = Date.now();
      this._emitHealth("connected", { host });
    });
    ws.on("ping", () => {
      if (this._wsGeneration !== generation || this.ws !== ws) return;
      this._lastWsAt = Date.now();
      try {
        if (typeof ws.pong === "function") ws.pong();
      } catch {
        /* ignore */
      }
    });
    ws.on("message", (buf) => {
      if (this._wsGeneration !== generation) return;
      this._lastWsAt = Date.now();
      this._onWs(buf);
    });
    ws.on("close", () => {
      if (this._wsGeneration !== generation || this.ws !== ws) return;
      if (this._wsConnectTimer) {
        clearTimeout(this._wsConnectTimer);
        this._wsConnectTimer = null;
      }
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      if (this.ws === ws) this.ws = null;
      this._emitHealth("reconnecting", { host, reason: "close" });
      this._scheduleReconnect();
    });
    ws.on("error", () => {
      if (this._wsGeneration !== generation || this.ws !== ws) return;
      this._safeClose(ws);
      this.ws = null;
      if (this._wsConnectTimer) {
        clearTimeout(this._wsConnectTimer);
        this._wsConnectTimer = null;
      }
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      this._scheduleReconnect();
      this._emitHealth("reconnecting", { host, reason: "socket_error" });
    });
  }

  _scheduleReconnect() {
    if (!this._wanted || this._reconnectTimer) return;
    this._wsIndex += 1;
    const delay = Math.min(15_000, 800 * Math.pow(1.6, Math.min(this._wsIndex, 8)));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openWs();
    }, delay);
  }

  _onWs(buf) {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    const data = msg.data || msg;
    if (data.e === "aggTrade" || data.e === "trade") {
      this._applyTrade(Number(data.p), Number(data.T || data.E || Date.now()));
      return;
    }
    if (data.e === "kline" && data.k) this._applyKline(data.k);
  }

  _applyTrade(price, ts) {
    if (!Number.isFinite(price)) return;
    const interval = INTERVAL_MS[this.timeframe] || 900_000;
    const openTs = Math.floor(ts / interval) * interval;
    if (!this.forming) {
      this.forming = {
        openTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        closeTs: openTs + interval - 1,
        closed: false,
      };
    } else if (openTs > this.forming.openTs) {
      const closed = {
        ...this.forming,
        closed: true,
        closeTs: this.forming.openTs + interval - 1,
      };
      const last = this.bars[this.bars.length - 1];
      if (!last || last.openTs !== closed.openTs) {
        this._upsertBar(closed);
      }
      this.forming = {
        openTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        closeTs: openTs + interval - 1,
        closed: false,
      };
    } else if (openTs === this.forming.openTs) {
      this.forming.close = price;
      this.forming.high = Math.max(this.forming.high, price);
      this.forming.low = Math.min(this.forming.low, price);
    }
    this._emitTick(false);
  }

  _applyKline(k) {
    const bar = {
      openTs: Number(k.t),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      closeTs: Number(k.T),
      closed: Boolean(k.x),
    };
    if (bar.closed) {
      const closedBar = { ...bar, closed: true };
      this._wsClosedBars.set(closedBar.openTs, closedBar);
      while (this._wsClosedBars.size > HISTORY_BARS) this._wsClosedBars.delete(this._wsClosedBars.keys().next().value);
      this._upsertBar(closedBar);
      const interval = INTERVAL_MS[this.timeframe] || 900_000;
      const recent = closedBar.closeTs >= Date.now() - interval;
      const contiguous = this.bars.some((item) => item.openTs === closedBar.openTs - interval);
      if (recent && contiguous && !this._wsSignalledBars.has(closedBar.openTs)) {
        this._wsSignalledBars.add(closedBar.openTs);
        while (this._wsSignalledBars.size > HISTORY_BARS) this._wsSignalledBars.delete(this._wsSignalledBars.values().next().value);
        this.emit("bar_close", closedBar);
      }
      if (this.forming && this.forming.openTs === bar.openTs) this.forming = null;
      this._emitTick(true);
      return;
    }
    if (this._wsClosedBars.has(bar.openTs)) return;
    const latest = this.bars[this.bars.length - 1];
    if ((latest && bar.openTs <= latest.openTs) || (this.forming && bar.openTs < this.forming.openTs)) return;
    this.forming = bar;
    this._emitTick(false);
  }

  _emitTick(force) {
    const now = Date.now();
    if (!force && now - this._lastTickEmit < this.refreshMs) return;
    this._lastTickEmit = now;
    this.emit("tick", { forming: this.forming, last: this.bars[this.bars.length - 1] });
  }

  _upsertBar(bar) {
    const index = this.bars.findIndex((item) => item.openTs === bar.openTs);
    if (index >= 0) this.bars[index] = bar;
    else this.bars.push(bar);
    this.bars.sort((a, b) => a.openTs - b.openTs);
    this._trimBars();
  }

  _trimBars() {
    if (this.bars.length > HISTORY_BARS) this.bars.splice(0, this.bars.length - HISTORY_BARS);
  }

  _emitReconciledClose(prevTs) {
    if (prevTs == null) return;
    const latest = this.bars[this.bars.length - 1];
    if (!latest || latest.openTs <= prevTs || this._wsSignalledBars.has(latest.openTs)) return;
    this._wsSignalledBars.add(latest.openTs);
    while (this._wsSignalledBars.size > HISTORY_BARS) this._wsSignalledBars.delete(this._wsSignalledBars.values().next().value);
    this.emit("bar_close", { ...latest, recovered: true });
  }
}

module.exports = { MarketData, INTERVAL_MS, parseKlines, clampRefreshMs };
