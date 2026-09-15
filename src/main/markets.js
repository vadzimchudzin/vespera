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
  return row ? row.label : id;
}

module.exports = {
  INTERVAL_MS,
  TIMEFRAMES,
  SYMBOLS,
  TF_LABELS,
  clampRefreshMs,
  symbolLabel,
};
