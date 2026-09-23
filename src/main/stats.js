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

/** Per-day results of one book, newest day first. */
function dailyBreakdown(entries, book, days = 14) {
  const byDay = new Map();
  for (const e of entries) {
    if (e.type !== "settled" || bookOf(e) !== book) continue;
    const d = e.ts ? new Date(e.ts) : new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const row = byDay.get(key) || { day: key, bets: 0, wins: 0, pnl: 0, fees: 0 };
    row.bets += 1;
    if (e.status === "win") row.wins += 1;
    row.pnl += Number(e.pnl) || 0;
    row.fees += Number(e.feeUsd) || 0;
    byDay.set(key, row);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, days)
    .map((r) => ({ ...r, pnl: Number(r.pnl.toFixed(2)), fees: Number(r.fees.toFixed(2)), winRate: r.bets ? r.wins / r.bets : null }));
}

const CSV_COLUMNS = [
  ["time", (e) => e.ts || ""],
  ["book", (e) => bookOf(e)],
  ["side", (e) => e.side || ""],
  ["stake_usd", (e) => e.sizeUsd ?? ""],
  ["entry_price", (e) => e.entryPrice ?? e.price ?? ""],
  ["shares", (e) => e.shares ?? ""],
  ["fee_usd", (e) => e.feeUsd ?? ""],
  ["strike", (e) => e.strike ?? ""],
  ["settle_close", (e) => e.settleClose ?? ""],
  ["outcome", (e) => e.outcome || ""],
  ["result", (e) => e.status || ""],
  ["pnl_usd", (e) => e.pnl ?? ""],
  ["balance_after", (e) => e.balanceAfter ?? ""],
  ["round", (e) => e.slug || ""],
  ["order_id", (e) => e.orderId || ""],
];

function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV of settled bets (all books), with a UTF-8 BOM so Excel reads it. */
function toCsv(entries) {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(",")];
  let count = 0;
  for (const e of entries) {
    if (e.type !== "settled") continue;
    lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(e))).join(","));
    count += 1;
  }
  return { csv: `\ufeff${lines.join("\r\n")}\r\n`, count };
}

module.exports = { computeStats, todayPnl, bookOf, localDay, dailyBreakdown, toCsv };
