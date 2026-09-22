"use strict";

/**
 * Polymarket crypto Up/Down slugs (5m / 15m) are UTC-floored:
 *   {asset}-updown-{tf}-{unixStart}
 * Example: btc-updown-15m-1789677000
 *
 * Chart still uses Binance BTCUSDT. This module only maps
 * symbol + timeframe + candle open → the matching CLOB round.
 */

const TF_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function assetFromSymbol(symbol) {
  const id = String(symbol || "BTCUSDT").toUpperCase();
  if (id.startsWith("BTC")) return "btc";
  if (id.startsWith("ETH")) return "eth";
  if (id.startsWith("SOL")) return "sol";
  if (id.startsWith("XRP")) return "xrp";
  return id.replace(/USDT$|USD$|USDC$/, "").toLowerCase() || "btc";
}

function intervalSec(timeframe) {
  return TF_SECONDS[timeframe] || 900;
}

/**
 * Polymarket only lists 5m and 15m crypto Up/Down rounds.
 * Anything else (1m, 30m, 1h, 4h, 1d) has no round to bet on, so we say so
 * instead of silently pointing the order at the 15m market.
 */
const SUPPORTED_TF = ["5m", "15m"];

function isSupportedTimeframe(timeframe) {
  return SUPPORTED_TF.includes(String(timeframe));
}

function floorStartUnix(tsMs, timeframe) {
  const sec = intervalSec(timeframe);
  const unix = Math.floor(Number(tsMs) / 1000);
  if (!Number.isFinite(unix) || unix <= 0) {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % sec);
  }
  return unix - (unix % sec);
}

function updownSlug(symbol, timeframe, tsMs) {
  const tf = isSupportedTimeframe(timeframe) ? String(timeframe) : "15m";
  const start = floorStartUnix(tsMs, tf);
  return `${assetFromSymbol(symbol)}-updown-${tf}-${start}`;
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapTokens(market) {
  const outcomes = parseList(market && market.outcomes).map((o) => String(o).toLowerCase());
  const ids = parseList(market && market.clobTokenIds).map(String);
  const tokens = { UP: null, DOWN: null };
  for (let i = 0; i < Math.min(outcomes.length, ids.length); i += 1) {
    const name = outcomes[i];
    if (name === "up" || name === "yes") tokens.UP = ids[i];
    if (name === "down" || name === "no") tokens.DOWN = ids[i];
  }
  if (!tokens.UP && ids[0]) tokens.UP = ids[0];
  if (!tokens.DOWN && ids[1]) tokens.DOWN = ids[1];
  return tokens;
}

function pickMarket(event) {
  if (!event) return null;
  if (Array.isArray(event.markets) && event.markets[0]) return event.markets[0];
  return event;
}

function normalizeRound(event, slug) {
  const market = pickMarket(event);
  if (!market) return null;
  const tokens = mapTokens(market);
  const active = market.active !== false && event.active !== false;
  const closed = Boolean(market.closed || event.closed);
  const accepting = market.acceptingOrders !== false;
  return {
    venue: "polymarket",
    slug,
    title: event.title || market.question || slug,
    question: market.question || event.title || slug,
    conditionId: market.conditionId || null,
    tokens,
    active,
    closed,
    acceptingOrders: accepting && active && !closed,
    startDate: event.startDate || market.startDate || null,
    endDate: event.endDate || market.endDate || null,
  };
}

async function resolveUpDown(client, { symbol, timeframe, tsMs } = {}) {
  if (!isSupportedTimeframe(timeframe)) {
    return {
      ok: false,
      slug: null,
      reason: "timeframe_unsupported",
      timeframe: String(timeframe || ""),
      supported: SUPPORTED_TF.slice(),
    };
  }
  const slug = updownSlug(symbol, timeframe, tsMs == null ? Date.now() : tsMs);
  const res = await client.eventBySlug(slug);
  if (!res.ok || !res.json) {
    return {
      ok: false,
      slug,
      reason: res.status === 404 ? "market_not_found" : `http_${res.status}`,
      latencyMs: res.latencyMs,
    };
  }
  const round = normalizeRound(res.json, slug);
  if (!round || !round.tokens.UP || !round.tokens.DOWN) {
    return { ok: false, slug, reason: "tokens_missing", latencyMs: res.latencyMs };
  }
  return { ok: true, slug, round, latencyMs: res.latencyMs };
}

module.exports = {
  TF_SECONDS,
  SUPPORTED_TF,
  isSupportedTimeframe,
  assetFromSymbol,
  intervalSec,
  floorStartUnix,
  updownSlug,
  parseList,
  mapTokens,
  normalizeRound,
  resolveUpDown,
};
