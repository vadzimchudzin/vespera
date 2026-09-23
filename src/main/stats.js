"use strict";

const { breakEvenWinRate } = require("./risk");

/**
 * Performance of settled bets from the journal. Paper counts from the last
 * paper reset; live ("auto") bets are kept apart.
 */
function computeStats(entries, { mode = "paper", maxSteps = 6 } = {}) {
  const isLive = mode === "auto";
  const rows = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!isLive && e.type === "paper_reset") break;
    if (e.type !== "settled") continue;
    if ((e.mode === "auto") !== isLive) continue;
    rows.push(e);
  }
  rows.reverse();

  let wins = 0;
  let pnl = 0;
  let fees = 0;
  let staked = 0;
  let priceSum = 0;
  let priced = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let maxLossStreak = 0;
  let seriesDone = 0;
  let seriesHalted = 0;
  const stepHits = Array.from({ length: Math.max(1, maxSteps) }, () => 0);

  for (const e of rows) {
    const p = Number(e.pnl) || 0;
    pnl += p;
    fees += Number(e.feeUsd) || 0;
    staked += Number(e.sizeUsd) || 0;
    const price = Number(e.entryPrice ?? e.price);
    if (price > 0 && price < 1) {
      priceSum += price;
      priced += 1;
    }
    equity += p;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    // step of this bet within its series = losses before it + 1
    stepHits[Math.min(streak, stepHits.length - 1)] += 1;
    if (e.status === "win") {
      wins += 1;
      streak = 0;
      seriesDone += 1;
    } else {
      streak += 1;
      maxLossStreak = Math.max(maxLossStreak, streak);
      if (streak >= maxSteps) {
        seriesHalted += 1;
        streak = 0;
      }
    }
  }

  const count = rows.length;
  const avgPrice = priced ? priceSum / priced : null;
  return {
    mode,
    count,
    wins,
    losses: count - wins,
    winRate: count ? wins / count : null,
    breakEvenWinRate: breakEvenWinRate(avgPrice ?? 0.5),
    avgPrice,
    pnl: Number(pnl.toFixed(2)),
    fees: Number(fees.toFixed(2)),
    staked: Number(staked.toFixed(2)),
    roi: staked ? pnl / staked : null,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxLossStreak,
    seriesWon: seriesDone,
    seriesHalted,
    stepHits,
  };
}

module.exports = { computeStats };
