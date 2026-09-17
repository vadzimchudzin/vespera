"use strict";

/**
 * MA pullback — checklist:
 * trend = slow SMA (default 200),
 * pullback bar body fully beyond fast SMA (wicks ignored),
 * then (confirmCount + 1) consecutive full-body candles of the needed
 * color beyond the fast SMA (open and close on that side; wicks ignored),
 * bet on the next candle. Forming candle never signals.
 *
 * confirmCount 0 = first full poke (v0.8.4).
 * confirmCount 1 = one more same-color full body, then enter, etc.
 */

function sma(values, period, index) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    sum += values[i];
  }
  return sum / period;
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

/** Entire candle body closed below MA. Wicks do not count. */
function bodyBelow(bar, ma) {
  return bodyTop(bar) < ma;
}

/** Entire candle body closed above MA. Wicks do not count. */
function bodyAbove(bar, ma) {
  return bodyBottom(bar) > ma;
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

function consecutiveFullRun(bars, index, side, fastPeriod, closes) {
  let n = 0;
  for (let i = index; i >= 0; i -= 1) {
    const ma = sma(closes, fastPeriod, i);
    if (ma == null) break;
    const b = bars[i];
    const ok =
      side === "UP" ? isGreen(b) && bodyAbove(b, ma) : isRed(b) && bodyBelow(b, ma);
    if (!ok) break;
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
  const runLen = confirmCount + 1;
  const pullIndex = index - runLen;

  if (index < slowPeriod - 1 || pullIndex < 0) {
    return { signal: null, reason: "warming_up", ma20: null, ma200: null };
  }
  const bar = bars[index];
  const prev = bars[pullIndex];
  const closes = bars.map((b) => b.close);
  const ma20 = sma(closes, fastPeriod, index);
  const ma200 = sma(closes, slowPeriod, index);
  const ma20Prev = sma(closes, fastPeriod, pullIndex);
  if (ma20 == null || ma200 == null || ma20Prev == null) {
    return { signal: null, reason: "warming_up", ma20, ma200 };
  }
  if (bar.close === bar.open) {
    return { signal: null, reason: "doji", ma20, ma200 };
  }

  const pulledDown = bodyBelow(prev, ma20Prev);
  const pulledUp = bodyAbove(prev, ma20Prev);
  const closedAbove = bodyAbove(bar, ma20);
  const closedBelow = bodyBelow(bar, ma20);
  const beyond = ticksBeyond(bar.close, ma20, tickSize);
  const tickLong = beyond >= minCrossTicks;
  const tickShort = beyond >= minCrossTicks;
  const longRun = consecutiveFullRun(bars, index, "UP", fastPeriod, closes);
  const shortRun = consecutiveFullRun(bars, index, "DOWN", fastPeriod, closes);
  const longConfirmed = longRun >= runLen;
  const shortConfirmed = shortRun >= runLen;

  const longOk =
    bar.close > ma200 &&
    pulledDown &&
    closedAbove &&
    isGreen(bar) &&
    longConfirmed &&
    tickLong;

  const shortOk =
    bar.close < ma200 &&
    pulledUp &&
    closedBelow &&
    isRed(bar) &&
    shortConfirmed &&
    tickShort;

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
  if (bar.close > ma200 && !closedAbove) {
    return { signal: null, reason: "no_ma20_cross_up", ma20, ma200 };
  }
  if (bar.close < ma200 && !closedBelow) {
    return { signal: null, reason: "no_ma20_cross_down", ma20, ma200 };
  }
  if (bar.close > ma200 && closedAbove && !isGreen(bar)) {
    return { signal: null, reason: "cross_but_not_green", ma20, ma200 };
  }
  if (bar.close < ma200 && closedBelow && !isRed(bar)) {
    return { signal: null, reason: "cross_but_not_red", ma20, ma200 };
  }
  if (bar.close > ma200 && closedAbove && !longConfirmed) {
    return { signal: null, reason: "need_more_confirms", ma20, ma200 };
  }
  if (bar.close < ma200 && closedBelow && !shortConfirmed) {
    return { signal: null, reason: "need_more_confirms", ma20, ma200 };
  }
  if (bar.close > ma200 && closedAbove && !tickLong) {
    return { signal: null, reason: "cross_too_shallow", ma20, ma200 };
  }
  if (bar.close < ma200 && closedBelow && !tickShort) {
    return { signal: null, reason: "cross_too_shallow", ma20, ma200 };
  }
  return { signal: null, reason: "no_setup", ma20, ma200 };
}

module.exports = {
  sma,
  atr,
  evaluateBar,
  bodyTop,
  bodyBottom,
  bodyBelow,
  bodyAbove,
  clampTicks,
  tickSizeOf,
  ticksBeyond,
  fastPeriodOf,
  slowPeriodOf,
  confirmCountOf,
};
