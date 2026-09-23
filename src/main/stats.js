"use strict";

const { breakEvenWinRate } = require("./risk");

/** Which book a journal entry belongs to: paper, Auto dry run, or real money. */
function bookOf(entry) {
  if (!entry || entry.mode !== "auto") return "paper";
  return entry.dryRun ? "dry" : "live";
}

/** Local calendar day, so the daily limit resets at the user's midnight. */
function localDay(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Realised P&L of one book today. */
function todayPnl(entries, book, now = Date.now()) {
  const day = localDay(now);
  let sum = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.ts && localDay(e.ts) !== day) break;
    if (book === "paper" && e.type === "paper_reset") break;
    if (e.type === "settled" && bookOf(e) === book) sum += Number(e.pnl) || 0;
  }
  return Number(sum.toFixed(2));
}

/**
 * Performance of settled bets of one book. Paper counts from the last paper
 * reset; dry-run and live bets are kept apart from it and from each other.
 */
function computeStats(entries, { book = "paper", maxSteps = 6 } = {}) {
  const rows = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (book === "paper" && e.type === "paper_reset") break;
    if (e.type !== "settled") continue;
    if (bookOf(e) !== book) continue;
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
    book,
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

module.exports = { computeStats, todayPnl, bookOf, localDay };
