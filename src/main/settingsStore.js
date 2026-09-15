"use strict";

const fs = require("fs");
const path = require("path");
const { clampRefreshMs } = require("./markets");

const DEFAULTS = {
  symbol: "BTCUSDT",
  timeframe: "15m",
  baseUsd: "1.00",
  maxSteps: 6,
  paperBalance: "1000.00",
  mode: "paper",
  theme: "glass-dark",
  locale: "en",
  apiKey: "",
  apiBase: "https://preddy.trade",
  requirePriorPenetration: false,
  maType: "SMA",
  strategyId: "sma200_20",
  minOpeningAtr: 0,
  refreshMs: 100,
};

class SettingsStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "settings.json");
    this.value = { ...DEFAULTS, ...this._read() };
    this.value.refreshMs = clampRefreshMs(this.value.refreshMs);
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  save(patch = {}) {
    this.value = { ...this.value, ...patch };
    if (patch.refreshMs != null) this.value.refreshMs = clampRefreshMs(patch.refreshMs);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const safe = { ...this.value };
    fs.writeFileSync(this.file, JSON.stringify(safe, null, 2));
    return this.value;
  }
}

module.exports = { SettingsStore, DEFAULTS };
