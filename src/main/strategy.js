"use strict";

/**
 * MA200 / MA20 pullback — checklist:
 * trend = SMA200, pullback through SMA20, confirm close back through SMA20,
 * bet on the next candle S+1. Forming candle never signals.
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

function crossedUp(bar, ma20) {
  return bar.low <= ma20 && bar.close > ma20;
}

function crossedDown(bar, ma20) {
  return bar.high >= ma20 && bar.close < ma20;
}

function clampTicks(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function evaluateBar(bars, index, options = {}) {
  const minOpeningAtr = Number(options.minOpeningAtr || 0);
  const minCrossTicks = clampTicks(options.minCrossTicks);
  if (index < 199) {
    return { signal: null, reason: "warming_up", ma20: null, ma200: null };
  }
  const bar = bars[index];
  const prev = bars[index - 1];
  const closes = bars.map((b) => b.close);
  const ma20 = sma(closes, 20, index);
  const ma200 = sma(closes, 200, index);
  const ma20Prev = sma(closes, 20, index - 1);
  if (ma20 == null || ma200 == null || ma20Prev == null) {
    return { signal: null, reason: "warming_up", ma20, ma200 };
  }
  if (bar.close === bar.open) {
    return { signal: null, reason: "doji", ma20, ma200 };
  }

  const pulledDown = prev.low < ma20Prev;
  const pulledUp = prev.high > ma20Prev;
  const tickLong = bar.close - ma20 >= minCrossTicks;
  const tickShort = ma20 - bar.close >= minCrossTicks;

  const longOk =
    bar.close > ma200 &&
    pulledDown &&
    crossedUp(bar, ma20) &&
    isGreen(bar) &&
    tickLong;

  const shortOk =
    bar.close < ma200 &&
    pulledUp &&
    crossedDown(bar, ma20) &&
    isRed(bar) &&
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
      crossTicks: longOk ? bar.close - ma20 : ma20 - bar.close,
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
  if (bar.close > ma200 && !crossedUp(bar, ma20)) {
    return { signal: null, reason: "no_ma20_cross_up", ma20, ma200 };
  }
  if (bar.close < ma200 && !crossedDown(bar, ma20)) {
    return { signal: null, reason: "no_ma20_cross_down", ma20, ma200 };
  }
  if (bar.close > ma200 && crossedUp(bar, ma20) && !isGreen(bar)) {
    return { signal: null, reason: "cross_but_not_green", ma20, ma200 };
  }
  if (bar.close < ma200 && crossedDown(bar, ma20) && !isRed(bar)) {
    return { signal: null, reason: "cross_but_not_red", ma20, ma200 };
  }
  if (bar.close > ma200 && crossedUp(bar, ma20) && !tickLong) {
    return { signal: null, reason: "cross_too_shallow", ma20, ma200 };
  }
  if (bar.close < ma200 && crossedDown(bar, ma20) && !tickShort) {
    return { signal: null, reason: "cross_too_shallow", ma20, ma200 };
  }
  return { signal: null, reason: "no_setup", ma20, ma200 };
}

module.exports = {
  sma,
  atr,
  evaluateBar,
  crossedUp,
  crossedDown,
  clampTicks,
};
