"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateSetupSettings, fingerprint } = require("./setupStore");
const { INTERVAL_MS } = require("./markets");

const MAX_RUNS = 30;
const MAX_TRADES = 20_000;
const MAX_DATA_BARS = 5_000;
const MAX_STATE_BYTES = 64 * 1024 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function validateRun(run) {
  if (!isObject(run) || typeof run.id !== "string" || !/^[a-f0-9-]{36}$/.test(run.id) ||
      !["backtest", "paper"].includes(run.mode) || !["complete", "running", "stopped", "error"].includes(run.status) ||
      !isObject(run.setup) || !isObject(run.setup.settings) || typeof run.setup.fingerprint !== "string" ||
      !Number.isInteger(run.setup.version) || run.setup.version < 1 ||
      !Number.isFinite(Number(run.startingBalance)) || Number(run.startingBalance) < 0.01 ||
      !Array.isArray(run.trades) || run.trades.length > MAX_TRADES ||
      !Array.isArray(run.bars) || run.bars.length > MAX_DATA_BARS ||
      typeof run.approximate !== "boolean" || !Number.isFinite(Date.parse(run.createdAt))) throw fail("research_store_corrupt");
  try { validateSetupSettings(run.setup.settings); } catch { throw fail("research_store_corrupt"); }
  if (run.setup.signalTimeframe !== run.setup.marketTimeframe || run.setup.signalTimeframe !== run.setup.settings.timeframe ||
      fingerprint(run.setup.settings, run.setup.signalTimeframe, run.setup.marketTimeframe) !== run.setup.fingerprint ||
      (run.tickSize != null && (!Number.isFinite(run.tickSize) || run.tickSize <= 0))) throw fail("research_store_corrupt");
  if (run.paperState) {
    const state = run.paperState;
    const risk = state.risk;
    if (!isObject(state) || !isObject(risk) || !Number.isFinite(Number(state.balance)) || Number(state.balance) < 0 ||
        !Number.isFinite(Number(state.startingBalance)) || Number(state.startingBalance) <= 0 ||
        !Number.isInteger(risk.step) || risk.step < 1 || risk.step > 20 || !Number.isInteger(risk.consecutiveLosses) || risk.consecutiveLosses < 0 ||
        !Number.isFinite(risk.seriesLossUsd) || risk.seriesLossUsd < 0 || typeof risk.halted !== "boolean" || typeof risk.lotConfirmed !== "boolean") throw fail("research_store_corrupt");
    const bet = state.openBet;
    if (bet) {
      const interval = INTERVAL_MS[run.setup.settings.timeframe];
      if (!isObject(bet) || !["UP", "DOWN"].includes(bet.side) || !Number.isFinite(Number(bet.sizeUsd)) || Number(bet.sizeUsd) <= 0 ||
          !Number.isFinite(Number(bet.feeUsd)) || Number(bet.feeUsd) < 0 || !Number.isFinite(bet.shares) || bet.shares <= 0 ||
          !Number.isSafeInteger(bet.roundOpenTs) || bet.roundCloseTs !== bet.roundOpenTs + interval - 1 || !Number.isFinite(Number(bet.strike))) throw fail("research_store_corrupt");
    }
  }
  for (const trade of run.trades) {
    if (!isObject(trade) || !["win", "loss"].includes(trade.status) || !["UP", "DOWN"].includes(trade.side) ||
        !Number.isFinite(Number(trade.pnl)) || !Number.isFinite(Number(trade.ts))) throw fail("research_store_corrupt");
  }
  for (const bar of run.bars) {
    if (!isObject(bar) || !Number.isFinite(bar.openTs) || !Number.isFinite(bar.closeTs) ||
        ![bar.open, bar.high, bar.low, bar.close].every((n) => Number.isFinite(Number(n)))) throw fail("research_store_corrupt");
  }
  if (run.mode === "backtest" && (typeof run.datasetHash !== "string" || !/^[a-f0-9]{64}$/.test(run.datasetHash))) {
    throw fail("research_store_corrupt");
  }
  return run;
}

function validateState(state) {
  if (!isObject(state) || state.version !== 1 || !Array.isArray(state.runs) || state.runs.length > MAX_RUNS) {
    throw fail("research_store_corrupt");
  }
  const ids = new Set();
  for (const run of state.runs) {
    validateRun(run);
    if (ids.has(run.id)) throw fail("research_store_corrupt");
    ids.add(run.id);
  }
  return state;
}

function emptyState() { return { version: 1, runs: [] }; }

class ResearchStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "research.json");
    this.backup = path.join(root, "research.json.bak");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.value = this._read();
  }

  _read() {
    let stat;
    try { stat = fs.lstatSync(this.file); } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077)) || stat.size > MAX_STATE_BYTES) {
      throw fail("research_store_permissions_invalid");
    }
    try { return validateState(JSON.parse(fs.readFileSync(this.file, "utf8"))); }
    catch (error) { if (error.code?.startsWith("research_store_")) throw error; throw fail("research_store_corrupt"); }
  }

  save(next) {
    const value = validateState(structuredClone(next));
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) throw fail("research_store_too_large");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file)) {
      const backupTemp = `${this.backup}.${crypto.randomUUID()}.tmp`;
      const backupFd = fs.openSync(backupTemp, "wx", 0o600);
      try {
        fs.writeFileSync(backupFd, fs.readFileSync(this.file));
        fs.fsyncSync(backupFd);
      } finally { fs.closeSync(backupFd); }
      fs.renameSync(backupTemp, this.backup);
    }
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    try {
      const dirFd = fs.openSync(this.root, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) { if (process.platform !== "win32") throw error; }
    this.value = value;
    return structuredClone(value);
  }
}

module.exports = { ResearchStore, validateState, MAX_RUNS, MAX_TRADES, MAX_DATA_BARS, MAX_STATE_BYTES };
