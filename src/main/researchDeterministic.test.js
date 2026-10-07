"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExecutionHost } = require("./executionHost");
const { ResearchRunner, validateBars } = require("./researchRunner");

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-replay-proof-"));
  const bars = Array.from({ length: 350 }, (_, i) => {
    const center = 100 + i * 0.03 + Math.sin(i * 0.9) * 2;
    const open = center + Math.sin(i) * 0.6;
    const close = center + Math.cos(i) * 0.6;
    return { openTs: i * 900000, closeTs: (i + 1) * 900000 - 1, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close, closed: true };
  });
  const markets = [];
  const makeMarket = ({ symbol, timeframe }) => {
    const listeners = new Set();
    const market = { symbol, timeframe, bars: bars.slice(0, 5), starts: 0, stop() {}, start() { this.starts++; },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async loadHistory() { return this.bars; }, async emit(bar) { for (const listener of listeners) listener("bar_close", bar); } };
    markets.push(market); return market;
  };
  const host = new ExecutionHost({ userDataDir: root, engineOptions: { market: { bars, on() {}, start() {}, stop() {} }, live: { configure() {}, marketBuy() { assert.fail("no live calls"); } }, researchMarketFactory: makeMarket } });
  try {
    await host.call("saveSettings", [{ fastPeriod: 2, slowPeriod: 5, minCrossTicks: 0, maxSteps: 20 }]);
    const first = (await host.call("saveSetup", [{ name: "Replay exact data" }])).setup;
    const second = (await host.call("copySetup", [{ id: first.id, version: 1, name: "Independent" }])).setup;
    const input = { id: first.id, version: 1, startingBalance: 1000, bars };
    const a = (await host.call("runBacktest", [input])).run;
    const b = (await host.call("runBacktest", [input])).run;
    assert.equal(a.datasetHash, b.datasetHash);
    assert.deepEqual(a.stats, b.stats, "same dataset and configuration reproduce all economic metrics");
    assert.ok(a.stats.count > 0);
    const short = (await host.call("runBacktest", [{ ...input, bars: bars.slice(0, 200) }])).run;
    const prefix = a.trades.filter((trade) => trade.ts <= bars[199].closeTs).map((trade) => [trade.side, trade.ts, trade.sizeUsd, trade.pnl]);
    assert.deepEqual(prefix, short.trades.map((trade) => [trade.side, trade.ts, trade.sizeUsd, trade.pnl]), "future candles cannot alter preceding trades");
    const end = 100 * 900000;
    const bounded = (await host.call("runBacktest", [{ ...input, toTs: end }])).run;
    assert.ok(bounded.trades.every((trade) => trade.ts < end));
    assert.ok(bounded.period.toTs <= end);
    assert.throws(() => validateBars([{ ...bars[0], closed: false }], "15m"));
    await host.setResearchContext({ active: true });
    const started = await host.call("startPaperRuns", [{ setups: [{ id: first.id, version: 1 }, { id: second.id, version: 1 }], startingBalance: 1000 }]);
    assert.equal(host.research.streams.size, 1);
    assert.equal(markets.length, 1);
    for (const bar of bars.slice(5, 300)) {
      await markets[0].emit(bar);
      await host.research.streams.values().next().value.queue;
    }
    let books = (await host.call("researchStatus")).runs.filter((book) => book.mode === "paper");
    assert.equal(books.length, 2);
    assert.ok(books[0].stats.count > 0);
    assert.deepEqual(books[0].stats.pnl, books[1].stats.pnl);
    await host.call("stopPaperRun", [{ id: started.runs[0].id }]);
    assert.equal((await host.call("researchStatus")).runs.find((book) => book.id === started.runs[1].id).running, true);
    const restored = new ResearchRunner({ root: path.join(root, "research"), engine: host.engine, setupStore: host.setupStore, marketFactory: makeMarket });
    try {
      const saved = restored.researchStatus().runs.find((book) => book.id === books[0].id);
      assert.equal(saved.stats.pnl, books[0].stats.pnl);
      assert.equal(saved.balance, books[0].balance);
      const state = structuredClone(restored.store.value);
      state.runs.find((book) => book.mode === "paper").paperState.balance = "not-a-number";
      assert.throws(() => restored.store.save(state), /research_store_corrupt/);
    } finally { restored.dispose(); }
    console.log("Deterministic Paper replay, prefix, isolation and restart tests ok");
  } finally { host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
