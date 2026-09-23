"use strict";

/**
 * Series sizing, the entry-price filter and paper statistics.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Risk, perDollar, breakEvenWinRate } = require("./risk");
const { computeStats } = require("./stats");
const { Journal } = require("./journal");

// ── per-dollar economics ────────────────────────────────────────────────────
{
  const k = perDollar(0.5);
  assert.strictEqual(Number(k.fee.toFixed(4)), 0.035, "fee at 0.50 is 3.5% of the stake");
  assert.strictEqual(Number(k.win.toFixed(4)), 0.965);
  assert.strictEqual(Number(k.loss.toFixed(4)), 1.035);
  assert.strictEqual(Number(breakEvenWinRate(0.5).toFixed(4)), 0.5175, "need 51.75% to break even at 0.50");
  assert.ok(breakEvenWinRate(0.7) > 0.7, "at 0.70 the bar is above 70%");
  assert.strictEqual(perDollar(0.5, { rate: 0 }).win, 1, "fee-free market pays ×2 at 0.50");
}

// ── ×2 keeps the old behaviour, and does not recover ─────────────────────────
{
  const r = new Risk({ baseUsd: "1.00", maxSteps: 6 });
  assert.strictEqual(r.size(0.5).toFixed(2), "1.00");
  r.onLoss(1.04);
  assert.strictEqual(r.size(0.5).toFixed(2), "2.00");
  r.onLoss(2.07);
  assert.strictEqual(r.size(0.3).toFixed(2), "4.00", "×2 ignores the price");
  const plan = new Risk({ baseUsd: "1.00", maxSteps: 6 }).plan(0.5);
  assert.ok(plan.steps[5].winNet < 0, "a ×2 win on step 6 still ends the series in the red");
}

// ── recovery sizing: every winning step nets the base profit ─────────────────
{
  const r = new Risk({ baseUsd: "1.00", maxSteps: 6, sizingMode: "recover" });
  const k = perDollar(0.5);
  let lost = 0;
  for (let step = 1; step <= 5; step += 1) {
    const stake = r.size(0.5).toNumber();
    const winNet = stake * k.win - lost;
    assert.ok(winNet >= 1 * k.win - 1e-9, `step ${step}: win nets at least the base profit, got ${winNet}`);
    const cost = stake * k.loss;
    lost += cost;
    r.onLoss(cost);
  }
  assert.strictEqual(Number(r.seriesLossUsd.toFixed(2)), Number(lost.toFixed(2)));
  r.onWin();
  assert.strictEqual(r.seriesLossUsd, 0);
  assert.strictEqual(r.size(0.5).toFixed(2), "1.00", "a win resets to the base stake");

  // A pricier entry pays less per dollar, so the recovery stake is larger.
  const a = new Risk({ baseUsd: "1.00", sizingMode: "recover" });
  a.onLoss(1.04);
  assert.ok(a.size(0.7).toNumber() > a.size(0.5).toNumber());

  // Every recover-plan step nets the same base profit.
  const plan = new Risk({ baseUsd: "1.00", maxSteps: 6, sizingMode: "recover" }).plan(0.5);
  for (const s of plan.steps) assert.ok(s.winNet >= 0.96, `plan step ${s.step} winNet ${s.winNet}`);
  assert.ok(plan.totalAtRisk > 60 && plan.totalAtRisk < 90, `six recover losses cost ${plan.totalAtRisk}`);
}

// ── stake cap ────────────────────────────────────────────────────────────────
{
  const r = new Risk({ baseUsd: "1.00", sizingMode: "recover", maxStakeUsd: 5 });
  r.onLoss(10);
  assert.strictEqual(r.size(0.5).toFixed(2), "5.00");
  assert.strictEqual(r.isCapped(0.5), true);
  const off = new Risk({ baseUsd: "1.00", sizingMode: "recover", maxStakeUsd: 0 });
  off.onLoss(10);
  assert.strictEqual(off.isCapped(0.5), false, "0 means no cap");
}

// ── restart restores the series loss, paper reset / mode switch start fresh ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-risk-"));
  const j = new Journal(path.join(dir, "journal.jsonl"));
  j.write({ type: "settled", status: "loss", pnl: "-1.04" });
  j.write({ type: "settled", status: "loss", pnl: "-2.15" });
  let back = j.restoreRisk(6);
  assert.strictEqual(back.step, 3);
  assert.strictEqual(Number(back.seriesLossUsd.toFixed(2)), 3.19);
  j.write({ type: "paper_reset", balance: "1000.00" });
  back = j.restoreRisk(6);
  assert.strictEqual(back.step, 1, "paper reset starts a new series after restart too");
  assert.strictEqual(back.seriesLossUsd, 0);
  j.write({ type: "settled", status: "loss", pnl: "-1.04" });
  j.write({ type: "mode", mode: "auto" });
  assert.strictEqual(j.restoreRisk(6).step, 1, "mode switch starts a new series");
}

// ── stats ────────────────────────────────────────────────────────────────────
{
  const entries = [
    { type: "settled", status: "loss", pnl: "-50", sizeUsd: "50", feeUsd: "1" }, // before reset: ignored
    { type: "paper_reset" },
    { type: "settled", status: "win", pnl: "0.96", sizeUsd: "1", feeUsd: "0.04", entryPrice: 0.5 },
    { type: "settled", status: "loss", pnl: "-1.04", sizeUsd: "1", feeUsd: "0.04", entryPrice: 0.5 },
    { type: "settled", status: "loss", pnl: "-2.08", sizeUsd: "2", feeUsd: "0.08", entryPrice: 0.5 },
    { type: "settled", status: "win", pnl: "3.86", sizeUsd: "4", feeUsd: "0.14", entryPrice: 0.5 },
    { type: "settled", status: "win", mode: "auto", pnl: "9", sizeUsd: "9", feeUsd: "0.3" },
  ];
  const s = computeStats(entries, { mode: "paper", maxSteps: 6 });
  assert.strictEqual(s.count, 4, "only paper bets since the last reset");
  assert.strictEqual(s.wins, 2);
  assert.strictEqual(s.winRate, 0.5);
  assert.strictEqual(s.pnl, 1.7);
  assert.strictEqual(s.fees, 0.3);
  assert.strictEqual(s.maxDrawdown, 3.12);
  assert.strictEqual(s.maxLossStreak, 2);
  assert.deepStrictEqual(s.stepHits.slice(0, 3), [2, 1, 1]);
  assert.strictEqual(Number(s.breakEvenWinRate.toFixed(4)), 0.5175);
  const live = computeStats(entries, { mode: "auto", maxSteps: 6 });
  assert.strictEqual(live.count, 1, "live stats are separate");
  const halted = computeStats(
    Array.from({ length: 3 }, () => ({ type: "settled", status: "loss", pnl: "-1", sizeUsd: "1" })),
    { mode: "paper", maxSteps: 3 }
  );
  assert.strictEqual(halted.seriesHalted, 1);
}

console.log("risk + stats tests ok");
