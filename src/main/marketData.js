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

function fetchJson(url) {
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

class MarketData {
  constructor({ symbol = "BTCUSDT", timeframe = "15m" } = {}) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.bars = [];
    this.listeners = new Set();
    this.timer = null;
  }

  onBar(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners) fn(event, payload);
  }

  async loadHistory(limit = 500) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${this.symbol}` +
      `&interval=${this.timeframe}&limit=${limit}`;
    const raw = await fetchJson(url);
    const bars = parseKlines(raw);
    // last kline may still be forming
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
    this.emit("history", { bars: this.bars, forming: this.forming });
    return this.bars;
  }

  start() {
    this.stop();
    const tick = async () => {
      try {
        const prevLast = this.bars[this.bars.length - 1];
        await this.loadHistory(500);
        const last = this.bars[this.bars.length - 1];
        if (last && (!prevLast || last.openTs !== prevLast.openTs)) {
          this.emit("bar_close", last);
        }
        this.emit("tick", { forming: this.forming, last });
      } catch (err) {
        this.emit("error", String(err.message || err));
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

module.exports = { MarketData, INTERVAL_MS };
