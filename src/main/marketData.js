"use strict";

const https = require("https");

const INTERVAL_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

function defaultFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Vespera/0.1" } }, (res) => {
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

const KLINE_HOSTS = [
  "https://api.binance.com",
  "https://api.binance.us",
];

class MarketData {
  constructor({ symbol = "BTCUSDT", timeframe = "15m", fetchJson } = {}) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.fetchJson = fetchJson || defaultFetchJson;
    this.bars = [];
    this.forming = null;
    this.listeners = new Set();
    this.timer = null;
    this._busy = false;
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
    this.stop();
    const tick = async () => {
      if (this._busy) return;
      this._busy = true;
      try {
        const prevLast = this.bars[this.bars.length - 1];
        const prevTs = prevLast ? prevLast.openTs : null;
        const initial = this.bars.length === 0;
        await this.loadHistory(500, { emitHistory: initial });
        if (prevTs != null) {
          for (const bar of this.bars) {
            if (bar.openTs > prevTs) this.emit("bar_close", bar);
          }
        }
        this.emit("tick", { forming: this.forming, last: this.bars[this.bars.length - 1] });
      } catch (err) {
        this.emit("error", String(err.message || err));
      } finally {
        this._busy = false;
      }
    };
    tick();
    this.timer = setInterval(tick, 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { MarketData, INTERVAL_MS, parseKlines };
