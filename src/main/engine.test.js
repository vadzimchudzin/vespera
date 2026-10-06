"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { evaluateBar, sma } = require("./strategy");
const { Engine } = require("./engine");
const { MarketData } = require("./marketData");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function stubLive() {
  return {
    async ping() {
      return { ok: false, venue: "polymarket", message: "offline_test", trading: false };
    },
    async getBalance() {
      return null;
    },
    async marketBuy() {
      const err = new Error("auto_not_wired");
      err.code = "auto_not_wired";
      throw err;
    },
    configure() {
      return this;
    },
  };
}

function bar(open, high, low, close, extra = {}) {
  return { open, high, low, close, volume: 1, closed: true, ...extra };
}

function makeTrendBars({ n = 220, close = 110, trend = 0.05 }) {
  const bars = [];
  let c = close;
  for (let i = 0; i < n; i += 1) {
    c += trend;
    const openTs = i * 900_000;
    bars.push(
      bar(c, c + 1, c - 1, c, {
        openTs,
        closeTs: openTs + 899_999,
      })
    );
  }
  return bars;
}

function paintLong(bars, index) {
  if (!bars[index] || !bars[index - 1]) return;
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    index - 1
  );
  const prevTs = bars[index - 1].openTs;
  bars[index - 1] = bar(ma20Prev - 1, ma20Prev - 0.4, ma20Prev - 2, ma20Prev - 1.2, {
    openTs: prevTs,
    closeTs: prevTs + 899_999,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    index
  );
  const openTs = bars[index].openTs;
  bars[index] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2, {
    openTs,
    closeTs: openTs + 899_999,
  });
}

function paintShort(bars, index) {
  if (!bars[index] || !bars[index - 1]) return;
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    index - 1
  );
  const prevTs = bars[index - 1].openTs;
  bars[index - 1] = bar(ma20Prev + 1.2, ma20Prev + 2, ma20Prev + 0.4, ma20Prev + 1, {
    openTs: prevTs,
    closeTs: prevTs + 899_999,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    index
  );
  const openTs = bars[index].openTs;
  bars[index] = bar(ma20 + 2, ma20 + 4, ma20 - 3, ma20 - 2, {
    openTs,
    closeTs: openTs + 899_999,
  });
}

function paintSkip(bars, index) {
  const c = bars[index - 1].close;
  const openTs = bars[index].openTs;
  bars[index] = bar(c, c + 0.2, c - 0.2, c + 0.1, {
    openTs,
    closeTs: openTs + 899_999,
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vespera-paper-"));
}

function fakeMarket(bars) {
  return {
    bars,
    timer: null,
    listeners: new Set(),
    on(fn) {
      this.listeners.add(fn);
    },
    start() {
      this.timer = 1;
    },
    stop() {
      this.timer = null;
    },
  };
}

async function next(engine, bars, index) {
  await engine.onBarClose(bars[index]);
}

async function run() {
  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    engine.market.bars = bars.slice(0, 219);
    await engine.start();
    assert(engine.status === "watching", `start watching got ${engine.status}`);
    assert(engine.lastHandledOpenTs === bars[218].openTs, "must ignore already-closed last bar");

    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    assert(engine.paper.openBet, "paper bet after long");
    assert(engine.paper.openBet.side === "UP", "UP");
    assert(engine.paper.openBet.sizeUsd === "1.00", "base size");
    assert(engine.status === "waiting_settlement", "waiting");
    // offline: even odds, fee 2 × 0.07 × 0.25 = $0.035 → $0.04
    assert(engine.paper.balance.toFixed(2) === "998.96", `stake+fee deducted ${engine.paper.balance.toFixed(2)}`);

    engine.stop();
    assert(engine.running === false, "stopped running");
    assert(engine.paper.openBet, "stop keeps open bet");
    assert(engine.status === "waiting_settlement", "stop does not kill round");
    assert(engine.market.timer === 1, "chart keeps streaming after stop");

    engine.market.bars = bars.slice(0, 221);
    bars[220] = bar(bars[219].close, bars[219].close + 5, bars[219].close - 1, bars[219].close + 4, {
      openTs: bars[220].openTs,
      closeTs: bars[220].closeTs,
    });
    await next(engine, bars, 220);
    assert(!engine.paper.openBet, "settled after stop");
    assert(engine.paper.history[0].status === "win", "win");
    assert(engine.paper.balance.toFixed(2) === "1000.96", `balance ${engine.paper.balance.toFixed(2)}`);
    assert(engine.risk.step === 1, "win resets step");
    assert(engine.status === "stopped", "idle after settle while stopped");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 240, close: 110, trend: 0.05 });
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.start();
    const sizes = [];
    for (let k = 0; k < 6; k += 1) {
      const sig = 219 + k * 2;
      const settle = sig + 1;
      paintLong(bars, sig);
      engine.market.bars = bars.slice(0, sig + 1);
      await next(engine, bars, sig);
      assert(engine.paper.openBet, `bet ${k + 1}`);
      sizes.push(engine.paper.openBet.sizeUsd);
      bars[settle] = bar(
        bars[sig].close,
        bars[sig].close + 1,
        bars[sig].close - 5,
        bars[sig].close - 3,
        { openTs: bars[settle].openTs, closeTs: bars[settle].closeTs }
      );
      engine.market.bars = bars.slice(0, settle + 1);
      await next(engine, bars, settle);
      assert(engine.paper.history[0].status === "loss", `loss ${k + 1}`);
    }
    assert(sizes.join(",") === "1.00,2.00,4.00,8.00,16.00,32.00", `sizes ${sizes}`);
    assert(engine.risk.halted === true, "halt after 6");
    assert(engine.risk.canOpen() === false, "no 7th");
    assert(engine.status === "halt", "status halt");

    engine.running = true;
    engine.market.bars = bars;
    const before = engine.journal.entries.filter((e) => e.type === "order_sent").length;
    await engine.start();
    assert(engine.status === "halt", "start while halt does nothing");
    assert(engine.running === false, "start refused");

    engine.confirmLot("1.00");
    assert(engine.risk.halted === false, "lot clears halt");
    await engine.start();
    assert(engine.running === true, "start after lot");
    assert(engine.risk.step === 1, "series reset");
    assert(engine.journal.entries.filter((e) => e.type === "order_sent").length === before, "no extra order on resume");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    paintSkip(bars, 220);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.start();
    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    const step = engine.risk.step;
    engine.market.bars = bars.slice(0, 221);
    await next(engine, bars, 220);
    assert(engine.paper.history[0].status === "win" || engine.paper.openBet, "settled or still open");
    if (!engine.paper.openBet) {
      paintSkip(bars, 221);
      engine.market.bars = bars.slice(0, 222);
      const stepAfterWin = engine.risk.step;
      await next(engine, bars, 221);
      assert(engine.risk.step === stepAfterWin, "skip does not change step");
      assert(!engine.paper.openBet, "skip does not open");
    }
    assert(step === 1, "started at 1");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 221, close: 80, trend: -0.05 });
    paintShort(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.start();
    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    assert(engine.paper.openBet.side === "DOWN", "short");
    engine.market.bars = bars.slice(0, 221);
    await next(engine, bars, 219);
    assert(engine.paper.openBet, "duplicate close ignored");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 221, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.start();
    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    await engine.setMode("auto");
    assert(engine.mode === "paper", "cannot switch mode with open bet");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 221, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const first = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await first.start();
    first.market.bars = bars.slice(0, 220);
    await next(first, bars, 219);
    const restored = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 220)),
    });
    assert(restored.paper.openBet, "restore open paper bet");
    assert(restored.paper.openBet.sizeUsd === "1.00", "stake remembered");
    restored.running = false;
    restored.market.bars = bars.slice(0, 221);
    bars[220] = bar(bars[219].close, bars[219].close + 3, bars[219].close - 1, bars[219].close + 2, {
      openTs: bars[220].openTs,
      closeTs: bars[220].closeTs,
    });
    await next(restored, bars, 220);
    assert(restored.paper.history[0].status === "win", "restored bet settles");
  }

  {
    const klinesA = [];
    const klinesB = [];
    for (let i = 0; i < 10; i += 1) {
      const open = i * 900_000;
      const row = [open, "1", "1", "1", "1", "1", open + 899999];
      klinesA.push(row);
      klinesB.push(row);
    }
    klinesB.push([10 * 900_000, "1", "1", "1", "1", "1", 10 * 900_000 + 899999]);
    klinesB.push([11 * 900_000, "1", "1", "1", "1", "1", 11 * 900_000 + 899999]);
    let n = 0;
    const md = new MarketData({
      fetchJson: async () => {
        n += 1;
        return n === 1 ? klinesA : klinesB;
      },
    });
    const closed = [];
    md.on((event, payload) => {
      if (event === "bar_close") closed.push(payload.openTs);
    });
    await md.loadHistory(20, { emitHistory: true });
    md._busy = false;
    const prevLast = md.bars[md.bars.length - 1];
    const prevTs = prevLast.openTs;
    await md.loadHistory(20, { emitHistory: false });
    for (const b of md.bars) {
      if (b.openTs > prevTs) md.emit("bar_close", b);
    }
    assert(closed.length === 2, `missed bars emitted ${closed.length}`);
  }

  {
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const ev = evaluateBar(bars, 219);
    assert(ev.signal === "UP", ev.reason);
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 221, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    assert(engine.strategyId === "sma200_20", "default SMA200/20");
    assert(engine.strategy().name === "SMA200/20", "display name");
    assert(engine.snapshot().strategies.some((s) => s.id === "sma200_20"), "listed");
    const same = engine.setStrategy("sma200_20");
    assert(same.ok === true, "reselect ok");
    await engine.start();
    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    const blocked = engine.setStrategy("sma200_20");
    assert(blocked.ok === true, "same id while open is ok");
    assert(engine.snapshot().markers.length > 0, "markers while running");
    engine.stop();
    assert(engine.snapshot().markers.length > 0, "idle chart keeps setup arrows");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m", minCrossTicks: 0 },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 220)),
    });
    engine.tickSize = 0.01;
    engine.market.bars = bars.slice(0, 220);
    engine._replayMarkers(true);
    const before = engine.snapshot().markers.length;
    assert(before > 0, "markers at 0 ticks");
    await engine.applySettings({ minCrossTicks: 2000 });
    assert(engine.snapshot().markers.length === 0, "min-cross slider must drop arrows");
    await engine.applySettings({ minCrossTicks: 0 });
    assert(engine.snapshot().markers.length === before, "0 ticks restores arrows");
    await engine.applySettings({ confirmCount: 8 });
    assert(engine.snapshot().markers.length === 0, "high confirms must drop arrows");
    await engine.applySettings({ confirmCount: 0 });
    assert(engine.snapshot().markers.length === before, "confirm 0 restores arrows");
    await engine.applySettings({ fastPeriod: 10, slowPeriod: 50 });
    assert(engine.snapshot().settings.fastPeriod === 10, "fast SMA saved");
    assert(engine.snapshot().settings.slowPeriod === 50, "slow SMA saved");
    await engine.applySettings({ fastPeriod: 20, slowPeriod: 200 });
    assert(engine.snapshot().markers.length === before, "default SMA periods restore arrows");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.setMode("auto");
    assert(engine.mode === "auto", "auto selected");
    assert(engine.liveBalance.ok === false, "live balance missing");
    assert(engine.liveBalance.value === "0.00", "zeros when unavailable");
    assert(engine.liveBalance.pulsing === true, "pulse zeros");
    await engine.setMode("paper");
    assert(engine.liveBalance.source === "paper", "paper balance restored");
  }

  {
    const md = new MarketData({
      refreshMs: 250,
      fetchJson: async () => [[0, "1", "1", "1", "1", "1", 1]],
    });
    let ticks = 0;
    md.on((event) => {
      if (event === "tick") ticks += 1;
    });
    md._applyTrade(100, 1_000);
    md._applyTrade(101, 1_010);
    assert(ticks === 1, `throttled ticks ${ticks}`);
    md._lastTickEmit = 0;
    md._applyTrade(102, 1_020);
    assert(ticks === 2, "force gap allows next tick");
    assert(md.forming.close === 102, "forming follows last trade");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    const notes = [];
    engine.on((evt) => {
      if (evt.type === "notify") notes.push(evt.payload);
    });
    await engine.start();
    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    assert(engine.paper.openBet, "TZ: bet opens on closed S");
    assert(engine.paper.openBet.side === "UP", "UP");
    assert(Number(engine.paper.openBet.roundOpenTs) > bars[219].closeTs, "bet is on S+1");
    assert(notes.some((n) => n.kind === "setup"), "setup notify");
    engine.market.bars = bars.slice(0, 221);
    bars[220] = bar(bars[219].close, bars[219].close + 5, bars[219].close - 1, bars[219].close + 4, {
      openTs: bars[220].openTs,
      closeTs: bars[220].closeTs,
    });
    await next(engine, bars, 220);
    assert(!engine.paper.openBet, "TZ: settles on S+1 close");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 230, close: 110, trend: 0.05 });
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 2, timeframe: "15m" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.applySettings({ maxSteps: 2 });
    await engine.start();
    assert(engine.risk.maxSteps === 2, "maxSteps 2");
    for (let k = 0; k < 2; k += 1) {
      const sig = 219 + k * 2;
      const settle = sig + 1;
      paintLong(bars, sig);
      engine.market.bars = bars.slice(0, sig + 1);
      await next(engine, bars, sig);
      assert(engine.paper.openBet, `bet ${k + 1} of 2`);
      bars[settle] = bar(
        bars[sig].close,
        bars[sig].close + 1,
        bars[sig].close - 5,
        bars[sig].close - 3,
        { openTs: bars[settle].openTs, closeTs: bars[settle].closeTs }
      );
      engine.market.bars = bars.slice(0, settle + 1);
      await next(engine, bars, settle);
    }
    assert(engine.risk.halted === true, "halt after 2");
    assert(engine.status === "halt", "status halt at 2");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m", paperBalance: "1000.00" },
      live: stubLive(),
      market: fakeMarket(bars.slice(0, 219)),
    });
    engine.paper.balance = require("./money").Decimal("800.00");
    const snap = engine.resetPaper("1000.00");
    assert(snap.paper.balance === "1000.00", "paper reset");
    assert(engine.risk.step === 1, "series reset");
    engine.notificationsEnabled = false;
    const notes = [];
    engine.on((evt) => {
      if (evt.type === "notify") notes.push(evt.payload);
    });
    engine.notify("setup", "x", "y");
    assert(notes.length === 0, "notify toggle off");
    engine.notificationsEnabled = true;
    engine.notify("setup", "x", "y");
    assert(notes.length === 1, "notify toggle on");
  }

  {
    // Live result is booked on the bar, then checked against Polymarket's resolution.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-reconcile-"));
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    const live = { ...stubLive(), async resolvedOutcome() { return { resolved: true, outcome: "DOWN" }; } };
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "auto", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      live,
      market: fakeMarket(bars.slice(0, 219)),
    });
    engine.mode = "auto";
    engine.liveBet = {
      side: "UP",
      sizeUsd: "10.00",
      payout: 2,
      feeUsd: "0.35",
      strike: 100,
      slug: "btc-updown-15m-1",
      roundCloseTs: 2,
      placedAt: Date.now(),
    };
    const settled = engine._settleLive({ close: 100, closeTs: 2 });
    assert(settled.outcome === "UP" && settled.status === "win", "flat close books UP");
    assert(settled.pnl === "9.65", `live pnl nets the taker fee, got ${settled.pnl}`);
    const logs = [];
    engine.on((evt) => {
      if (evt.type === "log") logs.push(evt.payload.message);
    });
    engine._reconcileLive(settled, { attempts: 1, delayMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    assert(logs.some((m) => m.startsWith("settle_mismatch")), "a venue disagreement is reported");
  }

  {
    // Auto only trades pairs/timeframes that have a Polymarket round.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-auto-market-"));
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    const market = { ...fakeMarket(bars.slice(0, 219)), configured: [], async configure(p) { this.configured.push(p); } };
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", symbol: "ADAUSDT", timeframe: "1h", baseUsd: "1.00", maxSteps: 6 },
      live: stubLive(),
      market,
    });
    await engine.setMode("auto");
    assert(engine.settings.symbol === "BTCUSDT" && engine.settings.timeframe === "15m", "auto moves onto a Polymarket round");
    await engine.applySettings({ symbol: "PEPEUSDT", timeframe: "4h" });
    assert(engine.settings.symbol === "BTCUSDT" && engine.settings.timeframe === "15m", "auto refuses pairs without a round");
    await engine.applySettings({ symbol: "ETHUSDT", timeframe: "5m" });
    assert(engine.settings.symbol === "ETHUSDT" && engine.settings.timeframe === "5m", "supported picks go through");
    const snap = engine.snapshot();
    assert(snap.polymarketTimeframes.join() === "5m,15m", "UI learns the Polymarket timeframes");
    assert(snap.symbols.find((x) => x.id === "BTCUSDT").polymarket === true, "BTC flagged");
    assert(snap.symbols.find((x) => x.id === "PEPEUSDT").polymarket === false, "PEPE not flagged");
    await engine.setMode("paper");
    await engine.applySettings({ symbol: "PEPEUSDT", timeframe: "4h" });
    assert(engine.settings.symbol === "PEPEUSDT", "paper keeps the full list");

    const boot = new Engine({
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "vsp-auto-boot-")),
      settings: { mode: "auto", symbol: "PEPEUSDT", timeframe: "1d" },
      live: stubLive(),
      market: fakeMarket([]),
    });
    assert(boot.settings.symbol === "BTCUSDT" && boot.settings.timeframe === "15m", "a saved auto config is fitted at boot");
  }

  {
    // A restart mid-round restores the paper bet with its fee and shares, and the balance after the stake.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-restore-"));
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    const first = new Engine({ userDataDir: dir, settings: { mode: "paper" }, live: stubLive(), market: fakeMarket(bars) });
    const order = await first.paper.marketBuy({
      side: "UP",
      sizeUsd: "10.00",
      clientOrderId: "r1",
      round: { strike: 100, openTs: 1, closeTs: 2 },
      price: 0.5,
    });
    first.journal.write({ type: "order_sent", ...order });
    const again = new Engine({ userDataDir: dir, settings: { mode: "paper" }, live: stubLive(), market: fakeMarket(bars) });
    assert(again.paper.balance.toFixed(2) === "989.65", `restored balance after stake + fee, got ${again.paper.balance.toFixed(2)}`);
    const settled = again.paper.settle({ close: 101, closeTs: 2 });
    assert(settled.pnl === "9.65", `restored bet settles with its fee, got ${settled.pnl}`);
    assert(settled.balanceAfter === "1009.65", settled.balanceAfter);
  }

  {
    // An unsettled live bet survives a restart.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-restore-live-"));
    const first = new Engine({ userDataDir: dir, settings: { mode: "auto" }, live: stubLive(), market: fakeMarket([]) });
    first.journal.write({ type: "order_sent", mode: "auto", side: "DOWN", sizeUsd: "5.00", shares: 9.8, feeUsd: "0.17", slug: "s", strike: 1, roundCloseTs: 2 });
    const again = new Engine({ userDataDir: dir, settings: { mode: "auto" }, live: stubLive(), market: fakeMarket([]) });
    assert(again.liveBet && again.liveBet.side === "DOWN" && again.liveBet.shares === 9.8, "live bet restored");
  }

  {
    // Entry-price filter and price-aware recovery sizing on a real signal.
    const mk = (settings, price) => {
      const bars = makeTrendBars({ n: 222, close: 110, trend: 0.05 });
      paintLong(bars, 219);
      const live = {
        ...stubLive(),
        async getQuote() {
          return { ok: true, side: "UP", price, payout: 1 / price, feeRate: 0.07, feeExponent: 1, minOrderSize: 5 };
        },
      };
      const engine = new Engine({
        userDataDir: tmpDir(),
        settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m", ...settings },
        live,
        market: fakeMarket(bars.slice(0, 219)),
      });
      return { engine, bars };
    };

    let t = mk({ maxEntryPrice: 0.6 }, 0.72);
    await t.engine.start();
    t.engine.market.bars = t.bars.slice(0, 220);
    await next(t.engine, t.bars, 219);
    assert(!t.engine.paper.openBet, "ask 0.72 above the 0.60 limit is skipped");
    assert(t.engine.journal.entries.some((e) => e.reason === "price_above_max"), "skip is journaled");
    assert(t.engine.risk.step === 1, "a price skip does not touch the series");

    t = mk({ maxEntryPrice: 0.8 }, 0.72);
    await t.engine.start();
    t.engine.market.bars = t.bars.slice(0, 220);
    await next(t.engine, t.bars, 219);
    assert(t.engine.paper.openBet, "ask under the limit trades");

    t = mk({ sizingMode: "recover" }, 0.6);
    t.engine.risk.onLoss(1.03); // one lost $1 bet at 0.50
    await t.engine.start();
    t.engine.market.bars = t.bars.slice(0, 220);
    await next(t.engine, t.bars, 219);
    const bet = t.engine.paper.openBet;
    const expected = t.engine.risk.size(0.6, { rate: 0.07, exponent: 1 }).toFixed(2);
    assert(bet && bet.sizeUsd === expected, `recover stake uses the live price, ${bet && bet.sizeUsd} vs ${expected}`);
    assert(Number(bet.sizeUsd) > 2.5, "recovering at 0.60 needs more than ×2");
    const snap = t.engine.snapshot();
    assert(snap.plan && snap.plan.steps.length === 6, "plan is exposed");
    assert(snap.stats && snap.stats.book === "paper", "stats are exposed");
  }

  {
    // The pair / timeframe cannot move under an open bet.
    const bars = makeTrendBars({ n: 220, close: 110, trend: 0.05 });
    const market = { ...fakeMarket(bars.slice(0, 219)), configured: 0, async configure() { this.configured += 1; } };
    const engine = new Engine({ userDataDir: tmpDir(), settings: { mode: "paper", symbol: "BTCUSDT", timeframe: "15m" }, live: stubLive(), market });
    await engine.paper.marketBuy({ side: "UP", sizeUsd: "1.00", clientOrderId: "x", round: { strike: 100, openTs: 1, closeTs: 2 } });
    let locked = false;
    try {
      await engine.applySettings({ symbol: "ETHUSDT", timeframe: "5m", confirmCount: 2 });
    } catch (err) {
      locked = err.code === "settings_locked";
    }
    assert(locked, "an active-position settings patch is rejected atomically");
    assert(engine.settings.symbol === "BTCUSDT" && engine.settings.timeframe === "15m", "market locked while a bet is open");
    assert(market.configured === 0, "the feed was not switched");
    assert(engine.settings.confirmCount === 0, "a rejected save applies no partial settings");
    engine.paper.settle({ close: 101, closeTs: 2 });
    await engine.applySettings({ symbol: "ETHUSDT" });
    assert(engine.settings.symbol === "ETHUSDT" && market.configured === 1, "unlocked after settlement");
  }

  console.log("paper engine tests ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
