"use strict";

// Configuration and stored state of the agents desk: the defaults, the limits of every setting and the checks a
// state read back from disk must pass. Paper only: any other mode is refused until the live-trading certificate (M6).

const R = require("./roster");
const { freshBook, MAX_OPEN, MAX_CLOSED } = require("./paper");

const VERSION = 1;
const CONFIDENCES = new Set(["low", "medium", "high"]);
const HALT_REASONS = new Set(["manual", "daily_loss", "drawdown"]);

const DEFAULT_CONFIG = Object.freeze({
  mode: "paper", capitalUsd: 1000, perTradeUsd: 25, perMarketUsd: 50, perEventUsd: 100,
  sectorMaxPct: 30, exposureMaxPct: 80, dailyLossPct: 5, drawdownPct: 15,
  kellyFraction: 0.25, minEdgePct: 2, arbMinPct: 0.5, arbMinUsd: 0.1,
  maxAgents: 9, agentCapitalPct: 15,
  aiEnabled: true, aiDailyUsd: 1, aiEveryMin: 30,
  topEvents: 300, refreshMin: 30,
  notifyTrades: true, digestMin: 60, reportHourUtc: 6,
});
// [min, max, integer]
const LIMITS = Object.freeze({
  capitalUsd: [10, 10000000], perTradeUsd: [1, 1000000], perMarketUsd: [1, 1000000], perEventUsd: [1, 1000000],
  sectorMaxPct: [1, 100], exposureMaxPct: [1, 100], dailyLossPct: [0.5, 50], drawdownPct: [1, 90],
  kellyFraction: [0.01, 1], minEdgePct: [0.5, 50], arbMinPct: [0.1, 20], arbMinUsd: [0.01, 1000],
  maxAgents: [1, 16, true], agentCapitalPct: [1, 100],
  aiDailyUsd: [0, 50], aiEveryMin: [5, 1440, true],
  topEvents: [100, 500, true], refreshMin: [5, 1440, true],
  digestMin: [0, 1440, true], reportHourUtc: [0, 23, true],
});
const BOOLEANS = new Set(["aiEnabled", "notifyTrades"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
const isRecord = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
const num = (x) => typeof x === "number" && Number.isFinite(x);
const count = (x) => Number.isInteger(x) && x >= 0;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

function validateConfig(input, base = DEFAULT_CONFIG) {
  if (!isRecord(input)) throw fail("agents_config_invalid");
  const out = { ...DEFAULT_CONFIG, ...base };
  for (const [key, value] of Object.entries(input)) {
    if (key === "mode") {
      if (typeof value !== "string") throw fail("agents_config_invalid");
      if (value !== "paper") throw fail("agents_live_requires_certificate");
    } else if (BOOLEANS.has(key)) {
      if (typeof value !== "boolean") throw fail("agents_config_invalid");
      out[key] = value;
    } else if (LIMITS[key]) {
      const [lo, hi, integer] = LIMITS[key];
      if (!num(value) || value < lo || value > hi || (integer && !Number.isInteger(value))) throw fail("agents_config_invalid");
      out[key] = value;
    } else throw fail("agents_config_invalid");
  }
  out.mode = "paper";
  if (!(out.perTradeUsd <= out.perMarketUsd && out.perMarketUsd <= out.perEventUsd && out.perEventUsd <= out.capitalUsd)) throw fail("agents_limits_order");
  return out;
}

function initialState(config, now) {
  const day = dayKey(now);
  return {
    version: VERSION, config: { ...config }, createdAt: now, running: false, halt: null,
    roster: R.defaultRoster(now), book: freshBook(config.capitalUsd, now), counts: {}, groupSeq: 0,
    ai: { day, spentUsd: 0, calls: 0, errors: 0, lastError: null, forecasts: {}, checks: {}, lastForecastAt: 0, lastCheckAt: 0, lastPlanAt: now, notes: [] },
    maker: {}, notify: { lastDigestAt: now, lastReportDay: day, digest: [], count: 0 }, seen: {},
    lastSettleAt: 0, lastRosterAt: now,
  };
}

function validPosition(p) {
  return isRecord(p) && typeof p.id === "string" && typeof p.agentId === "string" && typeof p.type === "string" &&
    typeof p.eventId === "string" && typeof p.marketId === "string" && typeof p.conditionId === "string" && typeof p.tokenId === "string" &&
    (p.outcome === 0 || p.outcome === 1) && num(p.shares) && p.shares > 0 && num(p.cost) && p.cost >= 0 && num(p.fees) && p.fees >= 0 &&
    num(p.mark) && p.mark >= 0 && p.mark <= 1 && num(p.openedAt);
}

function validateState(v) {
  const ok = (cond) => { if (!cond) throw fail("agents_store_corrupt"); };
  ok(isRecord(v) && v.version === VERSION);
  try { v.config = validateConfig(v.config); } catch { ok(false); }
  ok(typeof v.running === "boolean" && num(v.createdAt));
  ok(v.halt === null || (isRecord(v.halt) && HALT_REASONS.has(v.halt.reason) && num(v.halt.at)));
  ok(Array.isArray(v.roster) && v.roster.length <= 64 && v.roster.every((a) => isRecord(a) && /^a\d{1,4}$/.test(a.id) && R.TYPES[a.type] &&
    R.STATUSES.has(a.status) && isRecord(a.params) && num(a.createdAt) && (a.pausedAt === null || num(a.pausedAt)) && count(a.pauses) &&
    (a.note === null || typeof a.note === "string")));
  ok(new Set(v.roster.map((a) => a.id)).size === v.roster.length);
  const b = v.book;
  ok(isRecord(b) && num(b.cash) && num(b.startCapital) && b.startCapital > 0 && num(b.peakEquity) && typeof b.day === "string" &&
    num(b.dayStartEquity) && num(b.feesPaid) && count(b.trades) && count(b.seq) && isRecord(b.realized) && isRecord(b.brier));
  ok(Array.isArray(b.positions) && b.positions.length <= MAX_OPEN && b.positions.every(validPosition));
  ok(Array.isArray(b.closed) && b.closed.length <= MAX_CLOSED && b.closed.every((p) => isRecord(p) && typeof p.agentId === "string" && num(p.pnl) && num(p.closedAt)));
  ok(Object.values(b.realized).every(num) && Object.values(b.brier).every((x) => isRecord(x) && count(x.n) && num(x.sum) && num(x.market)));
  ok(isRecord(v.counts) && Object.values(v.counts).every((c) => isRecord(c) && count(c.trades) && count(c.settled) && count(c.wins)) && count(v.groupSeq));
  const ai = v.ai;
  ok(isRecord(ai) && typeof ai.day === "string" && num(ai.spentUsd) && count(ai.calls) && count(ai.errors) && (ai.lastError === null || typeof ai.lastError === "string") &&
    isRecord(ai.forecasts) && isRecord(ai.checks) && num(ai.lastForecastAt) && num(ai.lastCheckAt) && num(ai.lastPlanAt) && Array.isArray(ai.notes));
  ok(Object.values(ai.forecasts).every((f) => isRecord(f) && num(f.p) && f.p >= 0 && f.p <= 1 && CONFIDENCES.has(f.confidence) && num(f.at)));
  ok(Object.values(ai.checks).every((c) => isRecord(c) && typeof c.status === "string" && num(c.at)));
  ok(isRecord(v.maker) && isRecord(v.notify) && num(v.notify.lastDigestAt) && Array.isArray(v.notify.digest) && count(v.notify.count) &&
    isRecord(v.seen) && num(v.lastSettleAt) && num(v.lastRosterAt));
  return v;
}

module.exports = { VERSION, DEFAULT_CONFIG, LIMITS, BOOLEANS, HALT_REASONS, fail, isRecord, num, count, dayKey, validateConfig, initialState, validPosition, validateState };
