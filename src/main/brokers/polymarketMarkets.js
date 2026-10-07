"use strict";

/**
 * Short and four-hour crypto Up/Down slugs are UTC-floored:
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
 * Only verified asset/timeframe mappings are selectable. Hourly markets use
 * ET labels; their actual UTC start/end is checked before accepting the round.
 */
const SUPPORTED_TF = ["5m", "15m", "1h", "4h"];
const LONG_ROUND_ASSETS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
const HOURLY_NAMES = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum", SOLUSDT: "solana", XRPUSDT: "xrp" };

function getSupportedTimeframes(symbol) {
  return LONG_ROUND_ASSETS.has(String(symbol).toUpperCase()) ? SUPPORTED_TF.slice() : ["5m", "15m"];
}

function isSupportedMarket(symbol, timeframe) {
  return isSupportedSymbol(symbol) && getSupportedTimeframes(symbol).includes(String(timeframe));
}

function isSupportedTimeframe(timeframe) {
  return SUPPORTED_TF.includes(String(timeframe));
}

/** Assets with live crypto Up/Down rounds (checked against Gamma, 2026-09). */
const SUPPORTED_ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"];

function isSupportedSymbol(symbol) {
  const id = String(symbol || "").toUpperCase();
  return SUPPORTED_ASSETS.some((a) => id === `${a}USDT`);
}

/** Nearest pair/timeframe Auto can actually trade. */
function fitToPolymarket(symbol, timeframe) {
  return {
    symbol: isSupportedSymbol(symbol) ? String(symbol).toUpperCase() : "BTCUSDT",
    timeframe: isSupportedMarket(symbol, timeframe) ? String(timeframe) : "15m",
  };
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
  if (!isSupportedMarket(symbol, timeframe)) return null;
  const tf = String(timeframe);
  const start = floorStartUnix(tsMs, tf);
  if (tf === "1h") {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric", hour: "numeric", hour12: true }).formatToParts(new Date(start * 1000)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value.toLowerCase()]));
    return `${HOURLY_NAMES[String(symbol).toUpperCase()]}-up-or-down-${parts.month}-${parts.day}-${parts.year}-${parts.hour}${parts.dayPeriod}-et`;
  }
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
    resolutionSource: market.resolutionSource || event.resolutionSource || null,
    description: market.description || event.description || "",
    tokenOutcomes: parseList(market.outcomes),
    tokenIds: parseList(market.clobTokenIds),
    roundStart: market.eventStartTime || event.eventStartTime || null,
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
  if (!isSupportedSymbol(symbol)) {
    return {
      ok: false,
      slug: null,
      reason: "symbol_unsupported",
      symbol: String(symbol || ""),
      supported: SUPPORTED_ASSETS.slice(),
    };
  }
  if (!isSupportedMarket(symbol, timeframe)) return { ok: false, slug: null, reason: "timeframe_unsupported", supported: getSupportedTimeframes(symbol) };
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
  if (["1h", "4h"].includes(timeframe)) {
    const expectedStart = floorStartUnix(tsMs == null ? Date.now() : tsMs, timeframe) * 1000;
    const expectedEnd = expectedStart + intervalSec(timeframe) * 1000;
    const labels = round.tokenOutcomes.map((value) => String(value).toLowerCase());
    const source = String(round.resolutionSource || "");
    const asset = assetFromSymbol(symbol);
    const correctSource = timeframe === "1h" ? source === `https://www.binance.com/en/trade/${String(symbol).replace("USDT", "_USDT")}` : source === `https://data.chain.link/streams/${asset}-usd-twap-60s-streams`;
    if (pickMarket(res.json)?.slug !== slug || Date.parse(round.roundStart) !== expectedStart || Date.parse(round.endDate) !== expectedEnd ||
        round.tokenIds.length !== 2 || new Set(round.tokenIds.map(String)).size !== 2 || round.tokenIds.some((id) => !/^\d+$/.test(String(id))) ||
        labels.length !== 2 || !labels.includes("up") || !labels.includes("down") || !correctSource || !/greater than or equal/i.test(round.description)) {
      return { ok: false, slug, reason: "market_contract_mismatch" };
    }
  }
  return { ok: true, slug, round, latencyMs: res.latencyMs };
}

module.exports = {
  TF_SECONDS,
  SUPPORTED_TF,
  SUPPORTED_ASSETS,
  getSupportedTimeframes,
  isSupportedMarket,
  isSupportedTimeframe,
  isSupportedSymbol,
  fitToPolymarket,
  assetFromSymbol,
  intervalSec,
  floorStartUnix,
  updownSlug,
  parseList,
  mapTokens,
  normalizeRound,
  resolveUpDown,
};
