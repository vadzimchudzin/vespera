"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");
const { SettingsStore } = require("./settingsStore");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");

const dirs = [];
function dir() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-settings-"));
  dirs.push(value);
  return value;
}
function make(settings = {}, live = {}) {
  return new Engine({
    userDataDir: dir(),
    settings: { mode: "paper", ...settings },
    market: { bars: [], on() {}, start() {}, stop() {} },
    live: { async getQuote() { return { ok: true, price: 0.5 }; }, ...live },
  });
}
const bar = { openTs: 0, closeTs: 899999, open: 100, close: 101, high: 102, low: 99 };
const signal = { signal: "UP", reason: "test" };

async function run() {
  {
    const e = make();
    await e.applySettings({ sizingMode: "fixed", fixedStakes: "5,10,20" });
    assert.deepStrictEqual(e.snapshot().settings.fixedStakes, [5, 10, 20]);
    assert.strictEqual(e.risk.baseUsd.toFixed(2), "5.00");
    assert.strictEqual(e.risk.maxSteps, 3);
    e.running = true;
    await e._openFromSignal(signal, bar);
    assert.strictEqual(e.paper.openBet.sizeUsd, "5.00");
    await assert.rejects(e.applySettings({ fixedStakes: [8, 16], theme: "glass-light" }), (err) => err.code === "settings_locked");
    assert.strictEqual(e.settings.theme, "glass-dark", "a locked patch is rejected atomically");
    await e.applySettings({ refreshMs: 2000, notificationsEnabled: false });
    assert.strictEqual(e.settings.refreshMs, 2000);
    assert.throws(() => e.confirmLot("9"), (err) => err.code === "settings_locked");
    e._settleIfOpen({ ...bar, openTs: 900000, closeTs: 1799999, close: 99 });
    assert.strictEqual(e.risk.consecutiveLosses, 1);
    await assert.rejects(e.applySettings({ fixedStakes: [5, 10] }), (err) => err.code === "settings_locked");
    await e.applySettings({ confirmCount: 1 });
    assert.strictEqual(e.risk.step, 2);
    assert.strictEqual(e.risk.size(0.7).toFixed(2), "10.00");
    assert.throws(() => e.confirmLot("5", { resetSeries: true }), (err) => err.code === "settings_locked", "Stop required to abandon a series");
    e.stop();
    const pnlBefore = e.todayPnl();
    e.confirmLot("5", { resetSeries: true });
    assert.strictEqual(e.risk.step, 1);
    assert.strictEqual(e.todayPnl(), pnlBefore, "resetting series does not erase daily losses");
    await e.applySettings({ fixedStakes: [8, 16] });
    assert.strictEqual(e.risk.size(0.7).toFixed(2), "8.00");
  }

  {
    const e = make();
    await assert.rejects(e.applySettings({ baseUsd: "0", theme: "glass-blue" }), (err) => err.code === "invalid_settings");
    assert.strictEqual(e.settings.theme, "glass-dark");
    assert.strictEqual(e.risk.baseUsd.toFixed(2), "1.00");
    await e.applySettings({ fastPeriod: 200, slowPeriod: 100 });
    assert.strictEqual(e.settings.slowPeriod, 201);
  }

  // A budget is a pre-entry stop, not a reduced stake or a late loss alert.
  for (const limits of [{ maxSeriesLossUsd: 5 }, { dailyLossLimitUsd: 5 }]) {
    const e = make({ baseUsd: "5", ...limits });
    e.running = true;
    await e._openFromSignal(signal, bar);
    assert.strictEqual(e.paper.openBet, null);
    assert.strictEqual(e.risk.step, 1);
    assert.strictEqual(e.running, false);
    assert.ok(e.pauseReason.startsWith("budget_exceeded"));
  }

  {
    const e = make({ sizingMode: "fixed", fixedStakes: [5, 10], maxSeriesLossUsd: 15 });
    e.running = true;
    await e._openFromSignal(signal, bar);
    e._settleIfOpen({ ...bar, openTs: 900000, closeTs: 1799999, close: 99 });
    await e._openFromSignal(signal, { ...bar, openTs: 1800000, closeTs: 2699999 });
    assert.strictEqual(e.paper.openBet, null, "stake plus fees would exceed the series budget");
    assert.strictEqual(e.risk.step, 2);
  }

  {
    const e = make({ mode: "auto", dryRun: false });
    e.liveBet = { side: "UP", sizeUsd: "5" };
    const before = e.risk.step;
    e.resetPaper("100");
    assert.strictEqual(e.risk.step, before);
    assert.ok(e.liveBet, "paper reset never clears a live position");
  }

  {
    const root = dir();
    const store = new SettingsStore(root);
    store.save({ sizingMode: "fixed", fixedStakes: "5,10,20" });
    assert.strictEqual(store.value.maxSteps, 3);
    assert.strictEqual(store.value.baseUsd, "5.00");
    assert.throws(() => store.save({ maxSteps: -2 }), (err) => err.code === "invalid_settings");
    const restored = new SettingsStore(root);
    assert.deepStrictEqual(restored.value.fixedStakes, [5, 10, 20]);
    assert.strictEqual(restored.value.maxSteps, 3);
  }

  // The second quote is checked again before any signed order is posted.
  {
    let posts = 0;
    const venue = new PolymarketAdapter({
      privateKey: "0x" + "11".repeat(32),
      walletAddress: "0x1111111111111111111111111111111111111111",
      apiKey: "test", apiSecret: "cw==", apiPassphrase: "test",
      client: { configure() {}, async postOrder() { posts += 1; } },
    });
    venue._sizeFromSignal = async () => ({ tokenId: "1", makerAmount: "5000000", takerAmount: "10000000", quote: { sizeUsd: "5", feeUsd: "0.20" } });
    await assert.rejects(venue.marketBuy({ sizeUsd: "5", maxTotalCostUsd: 5.1 }), (err) => err.code === "budget_exceeded" && !err.ambiguous);
    assert.strictEqual(posts, 0);
  }
  console.log("settings engine tests ok");
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
});
