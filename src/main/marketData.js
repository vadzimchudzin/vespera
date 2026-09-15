"use strict";

const https = require("https");
const { INTERVAL_MS } = require("./markets");

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

const WS_HOSTS = ["wss://stream.binance.com:9443", "wss://stream.binance.vision"];

function clampRefreshMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(2000, Math.max(1, Math.round(n)));
}

class MarketData {
  constructor({ symbol = "BTCUSDT", timeframe = "15m", fetchJson, refreshMs = 100 } = {}) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.fetchJson = fetchJson || defaultFetchJson;
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

  setRefreshMs(ms) {
    this.refreshMs = clampRefreshMs(ms);
  }

  async configure({ symbol, timeframe, refreshMs } = {}) {
    if (refreshMs != null) this.setRefreshMs(refreshMs);
    const nextSymbol = symbol || this.symbol;
    const nextTf = timeframe || this.timeframe;
    const changed = nextSymbol !== this.symbol || nextTf !== this.timeframe;
    this.symbol = nextSymbol;
    this.timeframe = nextTf;
    if (!changed) return this.bars;
    this.bars = [];
    this.forming = null;
    const keep = this._wanted;
    this.stop({ keepWanted: keep });
    await this.loadHistory(500);
    if (keep) this.start();
    return this.bars;
  }

  async loadHistory(limit = 500, { emitHistory = true } = {}) {
    let raw;
    let lastErr;
    for (const host of KLINE_HOSTS) {
      const url = `${host}/api/v3/klines?symbol=${this.symbol}&interval=${this.timeframe}&limit=${limit}`;
      try {
        raw = await this.fetchJson(url);
        if (Array.isArray(raw)) break;
        lastErr = new Error(`klines_not_array from ${host}`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!Array.isArray(raw)) throw lastErr || new Error("klines_failed");
    const bars = parseKlines(raw);
    const last = bars[bars.length - 1];
    const interval = INTERVAL_MS[this.timeframe] || 900_000;
    if (last && Date.now() < last.openTs + interval) {
      last.closed = false;
      this.forming = last;
      this.bars = bars.slice(0, -1);
    } else {
      this.forming = null;
      this.bars = bars;
    }
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
      try {
        const prevTs = this.bars.length ? this.bars[this.bars.length - 1].openTs : null;
        const liveForming = this.forming && this.ws ? { ...this.forming } : null;
        const initial = this.bars.length === 0;
        await this.loadHistory(500, { emitHistory: initial });
        if (liveForming) {
          if (this.forming && this.forming.openTs === liveForming.openTs) {
            this.forming.close = liveForming.close;
            this.forming.high = Math.max(this.forming.high, liveForming.high);
            this.forming.low = Math.min(this.forming.low, liveForming.low);
          } else if (!this.forming) {
            this.forming = liveForming;
          }
        }
        if (prevTs != null) {
          for (const bar of this.bars) {
            if (bar.openTs > prevTs) this.emit("bar_close", bar);
          }
        }
        if (!this.ws) this._emitTick(true);
      } catch (err) {
        this.emit("error", String(err.message || err));
      } finally {
        this._busy = false;
      }
    };
    if (this.bars.length === 0) reconcile();
    this.timer = setInterval(reconcile, 20000);
    this._openWs();
  }

  stop({ keepWanted = false } = {}) {
    if (!keepWanted) this._wanted = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  _openWs() {
    if (!WebSocketImpl || !this._wanted) return;
    const host = WS_HOSTS[this._wsIndex % WS_HOSTS.length];
    const url = wsUrl(host, this.symbol, this.timeframe);
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      this.emit("error", String(err.message || err));
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("message", (buf) => this._onWs(buf));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this._scheduleReconnect();
    });
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  _scheduleReconnect() {
    if (!this._wanted || this._reconnectTimer) return;
    this._wsIndex += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openWs();
    }, 800);
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
        this.bars.push(closed);
        this.emit("bar_close", closed);
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
      const last = this.bars[this.bars.length - 1];
      if (!last || last.openTs !== bar.openTs) {
        this.bars.push({ ...bar, closed: true });
        this.emit("bar_close", this.bars[this.bars.length - 1]);
      } else {
        this.bars[this.bars.length - 1] = { ...bar, closed: true };
      }
      if (this.forming && this.forming.openTs === bar.openTs) this.forming = null;
      this._emitTick(true);
      return;
    }
    this.forming = bar;
    this._emitTick(false);
  }

  _emitTick(force) {
    const now = Date.now();
    if (!force && now - this._lastTickEmit < this.refreshMs) return;
    this._lastTickEmit = now;
    this.emit("tick", { forming: this.forming, last: this.bars[this.bars.length - 1] });
  }
}

module.exports = { MarketData, INTERVAL_MS, parseKlines, clampRefreshMs };
