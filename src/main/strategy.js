"use strict";

/**
 * MA pullback — checklist:
 * trend = slow SMA (default 200),
 * S-1 body fully beyond fast SMA (wicks ignored),
 * S: either close-through (fullBodyOnS off) or a full body of the
 * needed color beyond the line (fullBodyOnS on),
 * then confirmCount extra qualifying candles of the same side,
 * bet on the next candle. Forming candle never signals.
 *
 * confirmCount 0 = first poke. Fire only on the exact run length
 * so a 3-bar run does not re-enter when confirms is 0 or 1.
 */

function sma(values, period, index) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    sum += values[i];
  }
  return sum / period;
}

/** Full SMA series. Same arithmetic as sma() so results are bit-identical. */
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    out[i] = sma(values, period, i);
  }
  return out;
}

/**
 * Full EMA series, seeded with the SMA of the first `period` closes
 * (the TradingView convention) so the line matches the customer's chart.
 */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = sma(values, period, period - 1);
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function normalizeMaType(value) {
  return String(value || "SMA").toUpperCase() === "EMA" ? "EMA" : "SMA";
}

function maTypeOf(options = {}) {
  return normalizeMaType(options.maType);
}

function buildSeries(values, period, type) {
  return normalizeMaType(type) === "EMA" ? emaSeries(values, period) : smaSeries(values, period);
}

/**
 * Cached moving-average series per bars array.
 * Marker replay evaluates every bar, so recomputing the whole series on each
 * index turned the redraw into O(n^2 * period). The cache is invalidated when
 * the array length or its last close changes.
 */
const SERIES_CACHE = new WeakMap();

function maSeriesFor(bars, closes, period, type) {
  const key = `${normalizeMaType(type)}:${period}`;
  let entry = SERIES_CACHE.get(bars);
  const last = closes.length ? closes[closes.length - 1] : null;
  if (!entry || entry.len !== closes.length || entry.last !== last) {
    entry = { len: closes.length, last, series: new Map() };
    SERIES_CACHE.set(bars, entry);
  }
  let series = entry.series.get(key);
  if (!series) {
    series = buildSeries(closes, period, type);
    entry.series.set(key, series);
  }
  return series;
}

function trueRange(bars, index) {
  const bar = bars[index];
  const range = bar.high - bar.low;
  if (index === 0) return range;
  const prev = bars[index - 1].close;
  return Math.max(range, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
}

function atr(bars, index, period = 14) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    sum += trueRange(bars, i);
  }
  return sum / period;
}

function isGreen(bar) {
  return bar.close > bar.open;
}

function isRed(bar) {
  return bar.close < bar.open;
}

function bodyTop(bar) {
  return Math.max(bar.open, bar.close);
}

function bodyBottom(bar) {
  return Math.min(bar.open, bar.close);
}

function bodyBelow(bar, ma) {
  return bodyTop(bar) < ma;
}

function bodyAbove(bar, ma) {
  return bodyBottom(bar) > ma;
}

function crossedUp(bar, ma) {
  return bar.low <= ma && bar.close > ma;
}

function crossedDown(bar, ma) {
  return bar.high >= ma && bar.close < ma;
}

function clampTicks(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function tickSizeOf(options) {
  const n = Number(options.tickSize);
  if (Number.isFinite(n) && n > 0) return n;
  return 0.0001;
}

function ticksBeyond(close, ma, tickSize) {
  return Math.abs(close - ma) / tickSize;
}

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fastPeriodOf(options = {}) {
  return clampInt(options.fastPeriod, 20, 2, 200);
}

function slowPeriodOf(options = {}) {
  const fast = fastPeriodOf(options);
  const slow = clampInt(options.slowPeriod, 200, 5, 500);
  return slow <= fast ? Math.min(500, fast + 1) : slow;
}

function confirmCountOf(options = {}) {
  return clampInt(options.confirmCount, 0, 0, 10);
}

function truthy(value, fallback) {
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  return fallback;
}

/** Default off: close-through SMA (v0.8.3). On: full body of needed color (v0.8.4). */
function fullBodyOnSOf(options = {}) {
  return truthy(options.fullBodyOnS, false);
}

function signalBarOk(bar, ma, side, fullBody) {
  if (side === "UP") {
    if (!isGreen(bar)) return false;
    return fullBody ? bodyAbove(bar, ma) : crossedUp(bar, ma);
  }
  if (!isRed(bar)) return false;
  return fullBody ? bodyBelow(bar, ma) : crossedDown(bar, ma);
}

function consecutiveRun(bars, index, side, fastSeries, fullBody) {
  let n = 0;
  for (let i = index; i >= 0; i -= 1) {
    const ma = fastSeries[i];
    if (ma == null) break;
    if (!signalBarOk(bars[i], ma, side, fullBody)) break;
    n += 1;
  }
  return n;
}

function evaluateBar(bars, index, options = {}) {
  const minOpeningAtr = Number(options.minOpeningAtr || 0);
  const minCrossTicks = clampTicks(options.minCrossTicks);
  const tickSize = tickSizeOf(options);
  const fastPeriod = fastPeriodOf(options);
  const slowPeriod = slowPeriodOf(options);
  const confirmCount = confirmCountOf(options);
  const fullBodyOnS = fullBodyOnSOf(options);
  const runLen = confirmCount + 1;
  const pullIndex = index - runLen;

  if (index < slowPeriod - 1 || pullIndex < 0) {
    return { signal: null, reason: "warming_up", ma20: null, ma200: null };
  }
  const bar = bars[index];
  const prev = bars[pullIndex];
  const maType = maTypeOf(options);
  const closes = bars.map((b) => b.close);
  const fastSeries = maSeriesFor(bars, closes, fastPeriod, maType);
  const slowSeries = maSeriesFor(bars, closes, slowPeriod, maType);
  const ma20 = fastSeries[index];
  const ma200 = slowSeries[index];
  const ma20Prev = fastSeries[pullIndex];
  if (ma20 == null || ma200 == null || ma20Prev == null) {
    return { signal: null, reason: "warming_up", ma20, ma200 };
  }
  if (bar.close === bar.open) {
    return { signal: null, reason: "doji", ma20, ma200 };
  }

  const pulledDown = bodyBelow(prev, ma20Prev);
  const pulledUp = bodyAbove(prev, ma20Prev);
  const longBar = signalBarOk(bar, ma20, "UP", fullBodyOnS);
  const shortBar = signalBarOk(bar, ma20, "DOWN", fullBodyOnS);
  const beyond = ticksBeyond(bar.close, ma20, tickSize);
  const tickLong = beyond >= minCrossTicks;
  const tickShort = beyond >= minCrossTicks;
  const longRun = consecutiveRun(bars, index, "UP", fastSeries, fullBodyOnS);
  const shortRun = consecutiveRun(bars, index, "DOWN", fastSeries, fullBodyOnS);
  const longConfirmed = longRun === runLen;
  const shortConfirmed = shortRun === runLen;

  const longOk =
    bar.close > ma200 && pulledDown && longBar && longConfirmed && tickLong;

  const shortOk =
    bar.close < ma200 && pulledUp && shortBar && shortConfirmed && tickShort;

  if (longOk || shortOk) {
    if (minOpeningAtr > 0) {
      const a = atr(bars, index, 14);
      const spreadAtr = a > 0 ? Math.abs(ma20 - ma200) / a : 0;
      if (spreadAtr < minOpeningAtr) {
        return {
          signal: null,
          reason: "ma_opening_too_small",
          ma20,
          ma200,
          spreadAtr,
        };
      }
    }
    return {
      signal: longOk ? "UP" : "DOWN",
      reason: longOk ? "long" : "short",
      ma20,
      ma200,
      tickSize,
      crossTicks: beyond,
      confirmCount,
      fastPeriod,
      slowPeriod,
      fullBodyOnS,
      maType,
    };
  }
  if (bar.close === ma200) {
    return { signal: null, reason: "close_eq_ma200", ma20, ma200 };
  }
  if (bar.close > ma200 && !pulledDown) {
    return { signal: null, reason: "no_pullback_down", ma20, ma200 };
  }
  if (bar.close < ma200 && !pulledUp) {
    return { signal: null, reason: "no_pullback_up", ma20, ma200 };
  }
  if (bar.close > ma200 && !longBar) {
    return { signal: null, reason: "no_ma20_cross_up", ma20, ma200 };
  }
  if (bar.close < ma200 && !shortBar) {
    return { signal: null, reason: "no_ma20_cross_down", ma20, ma200 };
  }
  if (bar.close > ma200 && longBar && !longConfirmed) {
    return { signal: null, reason: "need_more_confirms", ma20, ma200 };
  }
  if (bar.close < ma200 && shortBar && !shortConfirmed) {
    return { signal: null, reason: "need_more_confirms", ma20, ma200 };
  }
  if (bar.close > ma200 && longBar && !tickLong) {
    return { signal: null, reason: "cross_too_shallow", ma20, ma200 };
  }
  if (bar.close < ma200 && shortBar && !tickShort) {
    return { signal: null, reason: "cross_too_shallow", ma20, ma200 };
  }
  return { signal: null, reason: "no_setup", ma20, ma200 };
}

module.exports = {
  sma,
  smaSeries,
  emaSeries,
  buildSeries,
  maSeriesFor,
  maTypeOf,
  atr,
  evaluateBar,
  bodyTop,
  bodyBottom,
  bodyBelow,
  bodyAbove,
  crossedUp,
  crossedDown,
  clampTicks,
  tickSizeOf,
  ticksBeyond,
  fastPeriodOf,
  slowPeriodOf,
  confirmCountOf,
  fullBodyOnSOf,
};
