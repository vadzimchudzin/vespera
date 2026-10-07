"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeSettings } = require("../shared/settings");
const { DEFAULTS } = require("./settingsStore");
const { SetupStore, settingsFromEngine } = require("./setupStore");
const { Risk } = require("./risk");
const { ResearchRunner } = require("./researchRunner");
const { INTERVAL_MS } = require("./markets");

const roots = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-research-"));
  roots.push(dir);
  return dir;
}

function fixtureBars() {
  const interval = INTERVAL_MS["1h"];
  const start = Date.UTC(2024, 0, 1);
  const closes = [10, 10, 10, 10, 10, 10, 9, 10, 10.5];
  return closes.map((close, index) => {
    const open = index === 6 ? 9.2 : index === 7 ? 9 : index ? closes[index - 1] : close;
    const low = index === 7 ? 8.9 : Math.min(open, close) - 0.1;
    const high = Math.max(open, close) + 0.1;
    const openTs = start + index * interval;
    return { openTs, closeTs: openTs + interval - 1, open, high, low, close, volume: 1, closed: true };
  });
}

function createSetup(setupStore, { baseUsd = "1.00" } = {}) {
  const settings = normalizeSettings({
    ...DEFAULTS,
    symbol: "BTCUSDT",
    timeframe: "1h",
    fastPeriod: 2,
    slowPeriod: 5,
    baseUsd,
    maxSteps: 1,
  }, {}, { strict: false });
  const engineLike = {
    settings,
    strategyId: "sma200_20",
    risk: new Risk(settings),
    dailyLossLimit: () => settings.dailyLossLimitUsd,
  };
  return setupStore.saveSetup({ name: `Research ${baseUsd}`, settings: settingsFromEngine(engineLike) });
}

class FakeMarket {
  constructor({ symbol, timeframe }) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.bars = [];
    this.listeners = new Set();
    this.starts = 0;
    this.stops = 0;
  }

  on(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async loadHistory() { return this.bars; }
  start() { this.starts += 1; }
  stop() { this.stops += 1; }
  emitBar(bar) {
    this.bars.push(bar);
    for (const callback of this.listeners) callback("bar_close", bar);
  }
}

function engineWith(market) {
  return {
    market,
    symbols: [],
    live: {
      marketBuy() { assert.fail("research must never submit live orders"); },
    },
  };
}

async function run() {
  const now = Date.UTC(2025, 0, 10);
  const bars = fixtureBars();
  const storeRoot = tempDir();
  const setupStore = new SetupStore(storeRoot);
  const one = createSetup(setupStore);
  const two = createSetup(setupStore, { baseUsd: "2.00" });

  const historical = new ResearchRunner({ root: path.join(storeRoot, "history"), setupStore, engine: engineWith(null), now: () => now });
  const first = await historical.runBacktest({ id: one.id, version: one.version, startingBalance: "1000.00", bars });
  const second = await historical.runBacktest({ id: one.id, version: one.version, startingBalance: "1000.00", bars });
  assert.equal(first.run.datasetHash, second.run.datasetHash, "identical candle input has a stable dataset hash");
  const withoutRunIds = (trades) => trades.map(({ clientOrderId, ...trade }) => trade);
  assert.deepEqual(withoutRunIds(first.run.trades), withoutRunIds(second.run.trades), "identical history and setup replay identically");
  assert.ok(first.run.trades.length > 0, "closed-bar fixture generates and settles a paper trade");
  assert.equal(first.run.trades[0].side, "UP");
  assert.equal(first.run.approximate, true, "assumed binary-market pricing is clearly marked approximate");
  historical.dispose();

  const paperRoot = path.join(storeRoot, "paper");
  const feeds = [];
  const marketFactory = (options) => {
    const feed = new FakeMarket(options);
    feeds.push(feed);
    return feed;
  };
  let runner = new ResearchRunner({ root: paperRoot, setupStore, engine: engineWith(null), marketFactory, now: () => now });
  await runner.setResearchContext({ active: true });
  const started = await runner.startPaperRuns({
    setups: [{ id: one.id, version: 1 }, { id: two.id, version: 1 }],
    startingBalance: "1000.00",
  });
  assert.equal(feeds.length, 1, "same symbol/timeframe experiments share one feed");
  assert.equal(runner.researchStatus().streams.length, 1);
  assert.equal(started.runs.length, 2);

  const feed = feeds[0];
  for (const bar of bars.slice(0, 8)) {
    feed.emitBar(bar);
    await runner.streams.get("BTCUSDT:1h").queue;
  }
  const open = runner.researchStatus().runs;
  assert.deepEqual(open.map((item) => item.openBet?.sizeUsd), ["1.00", "2.00"], "each experiment keeps its own risk and open position");
  await runner.stopPaperRun({ id: started.runs[0].id });
  runner.dispose();

  runner = new ResearchRunner({ root: paperRoot, setupStore, engine: engineWith(null), marketFactory, now: () => now });
  assert.equal(runner.researchStatus().runs.length, 2, "paper books restore without starting a live venue");
  assert.ok(runner.researchStatus().runs.every((item) => item.openBet), "unsettled paper positions survive a restart");
  await runner.setResearchContext({ active: true });
  const settlementFeed = feeds.at(-1);
  settlementFeed.emitBar(bars[8]);
  await runner.streams.get("BTCUSDT:1h").queue;

  const settled = runner.researchStatus().runs;
  assert.ok(settled.every((item) => item.trades.length === 1), "restored books persist their settlement trade");
  assert.ok(settled.every((item) => item.openBet === null));
  assert.notEqual(settled[0].trades[0].sizeUsd, settled[1].trades[0].sizeUsd, "settlement does not mix experiment balances");
  assert.ok(settled.every((item) => Number(item.balance) > 0));
  runner.dispose();

  const day = runner.researchReport({ period: "day" });
  assert.equal(day.runs.length, 2);
  assert.equal(day.runs[0].fromTs, Date.UTC(2025, 0, 10), "report day boundaries use the injected UTC clock");
  assert.equal(day.runs[0].toTs, now);
  console.log("Research replay and paper isolation tests ok");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
