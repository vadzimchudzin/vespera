"use strict";

/**
 * MA200 / MA20 pullback — canonical rules from TZ v1.
 * Strategy does not know Preddy. Returns Signal | null.
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

function evaluateBar(bars, index, options = {}) {
  const requirePrior = Boolean(options.requirePriorPenetration);
  const minOpeningAtr = Number(options.minOpeningAtr || 0);
  if (index < 199) {
    return { signal: null, reason: "warming_up", ma20: null, ma200: null };
  }
  const bar = bars[index];
  const closes = bars.map((b) => b.close);
  const ma20 = sma(closes, 20, index);
  const ma200 = sma(closes, 200, index);
  if (ma20 == null || ma200 == null) {
    return { signal: null, reason: "warming_up", ma20, ma200 };
  }
  if (bar.close === bar.open) {
    return { signal: null, reason: "doji", ma20, ma200 };
  }

  const longOk =
    bar.close > ma200 &&
    crossedUp(bar, ma20) &&
    isGreen(bar) &&
    (!requirePrior || (index > 0 && bars[index - 1].low < sma(closes, 20, index - 1)));

  const shortOk =
    bar.close < ma200 &&
    crossedDown(bar, ma20) &&
    isRed(bar) &&
    (!requirePrior || (index > 0 && bars[index - 1].high > sma(closes, 20, index - 1)));

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
    };
  }
  if (bar.close === ma200) {
    return { signal: null, reason: "close_eq_ma200", ma20, ma200 };
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
  return { signal: null, reason: "no_setup", ma20, ma200 };
}

module.exports = {
  sma,
  atr,
  evaluateBar,
  crossedUp,
  crossedDown,
};
