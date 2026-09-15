"use strict";

const INTERVAL_MS = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

const TIMEFRAMES = Object.keys(INTERVAL_MS);

/** Closed candles kept for SMA200 + chart. Binance serves 1000 per call; we page. */
const HISTORY_BARS = 2000;

const FALLBACK_TICK = {
  BTCUSDT: 0.01,
  ETHUSDT: 0.01,
  SOLUSDT: 0.01,
  BNBUSDT: 0.01,
  XRPUSDT: 0.0001,
  DOGEUSDT: 0.00001,
  ADAUSDT: 0.0001,
  AVAXUSDT: 0.01,
  LINKUSDT: 0.001,
  TONUSDT: 0.0001,
  SUIUSDT: 0.0001,
  NEARUSDT: 0.001,
  LTCUSDT: 0.01,
  DOTUSDT: 0.001,
  ATOMUSDT: 0.001,
  UNIUSDT: 0.001,
  APTUSDT: 0.0001,
  ARBUSDT: 0.0001,
  OPUSDT: 0.0001,
  PEPEUSDT: 1e-8,
};

function fallbackTick(id) {
  return FALLBACK_TICK[String(id || "").toUpperCase()] || 0.0001;
}

function tickSizeFromInfo(row) {
  const filters = (row && row.filters) || [];
  const price = filters.find((f) => f.filterType === "PRICE_FILTER");
  const n = Number(price && price.tickSize);
  if (Number.isFinite(n) && n > 0) return n;
  return fallbackTick(row && row.symbol);
}

const SYMBOLS = [
  { id: "BTCUSDT", label: "BTC/USDT" },
  { id: "ETHUSDT", label: "ETH/USDT" },
  { id: "SOLUSDT", label: "SOL/USDT" },
  { id: "BNBUSDT", label: "BNB/USDT" },
  { id: "XRPUSDT", label: "XRP/USDT" },
  { id: "DOGEUSDT", label: "DOGE/USDT" },
  { id: "ADAUSDT", label: "ADA/USDT" },
  { id: "AVAXUSDT", label: "AVAX/USDT" },
  { id: "LINKUSDT", label: "LINK/USDT" },
  { id: "TONUSDT", label: "TON/USDT" },
  { id: "SUIUSDT", label: "SUI/USDT" },
  { id: "NEARUSDT", label: "NEAR/USDT" },
  { id: "LTCUSDT", label: "LTC/USDT" },
  { id: "DOTUSDT", label: "DOT/USDT" },
  { id: "ATOMUSDT", label: "ATOM/USDT" },
  { id: "UNIUSDT", label: "UNI/USDT" },
  { id: "APTUSDT", label: "APT/USDT" },
  { id: "ARBUSDT", label: "ARB/USDT" },
  { id: "OPUSDT", label: "OP/USDT" },
  { id: "PEPEUSDT", label: "PEPE/USDT" },
];

const TF_LABELS = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  "8h": "8h",
  "12h": "12h",
  "1d": "1d",
};

function clampRefreshMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.min(2000, Math.max(1, Math.round(n)));
}

function symbolLabel(id) {
  const row = SYMBOLS.find((s) => s.id === id);
  return row ? row.label : String(id || "").replace(/USDT$/, "/USDT");
}

async function fetchExchangeSymbols(fetchJson) {
  const hosts = ["https://api.binance.com", "https://api.binance.us"];
  let info;
  let tickers;
  for (const host of hosts) {
    try {
      info = await fetchJson(`${host}/api/v3/exchangeInfo`);
      if (info && Array.isArray(info.symbols)) break;
    } catch {
      info = null;
    }
  }
  if (!info || !Array.isArray(info.symbols)) return SYMBOLS.slice();
  const usdt = info.symbols.filter(
    (s) => s.status === "TRADING" && s.quoteAsset === "USDT" && s.isSpotTradingAllowed !== false
  );
  try {
    for (const host of hosts) {
      try {
        tickers = await fetchJson(`${host}/api/v3/ticker/24hr`);
        if (Array.isArray(tickers)) break;
      } catch {
        tickers = null;
      }
    }
  } catch {
    tickers = null;
  }
  const vol = new Map();
  if (Array.isArray(tickers)) {
    for (const t of tickers) vol.set(t.symbol, Number(t.quoteVolume) || 0);
  }
  usdt.sort((a, b) => (vol.get(b.symbol) || 0) - (vol.get(a.symbol) || 0));
  const list = usdt.slice(0, 80).map((s) => ({
    id: s.symbol,
    label: `${s.baseAsset}/USDT`,
    tickSize: tickSizeFromInfo(s),
  }));
  return list.length ? list : SYMBOLS.map((s) => ({ ...s, tickSize: fallbackTick(s.id) }));
}

module.exports = {
  INTERVAL_MS,
  TIMEFRAMES,
  SYMBOLS,
  TF_LABELS,
  HISTORY_BARS,
  FALLBACK_TICK,
  clampRefreshMs,
  symbolLabel,
  fallbackTick,
  tickSizeFromInfo,
  fetchExchangeSymbols,
};
