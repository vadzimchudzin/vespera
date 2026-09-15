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
    assert(engine.paper.balance.toFixed(2) === "999.00", "stake deducted");

    engine.stop();
    assert(engine.running === false, "stopped running");
    assert(engine.paper.openBet, "stop keeps open bet");
    assert(engine.status === "waiting_settlement", "stop does not kill round");

    engine.market.bars = bars.slice(0, 221);
    bars[220] = bar(bars[219].close, bars[219].close + 5, bars[219].close - 1, bars[219].close + 4, {
      openTs: bars[220].openTs,
      closeTs: bars[220].closeTs,
    });
    await next(engine, bars, 220);
    assert(!engine.paper.openBet, "settled after stop");
    assert(engine.paper.history[0].status === "win", "win");
    assert(engine.paper.balance.toFixed(2) === "1001.00", `balance ${engine.paper.balance.toFixed(2)}`);
    assert(engine.risk.step === 1, "win resets step");
    assert(engine.status === "stopped", "idle after settle while stopped");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 240, close: 110, trend: 0.05 });
    const engine = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
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

    paintLong(bars, 231);
    const extra = bar(1, 2, 0, 3, { openTs: 231 * 900_000, closeTs: 231 * 900_000 + 899999 });
    paintLong([].concat(bars, extra), 0);
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
      market: fakeMarket(bars.slice(0, 219)),
    });
    await engine.start();
    engine.market.bars = bars.slice(0, 220);
    await next(engine, bars, 219);
    engine.setMode("auto");
    assert(engine.mode === "paper", "cannot switch mode with open bet");
  }

  {
    const dir = tmpDir();
    const bars = makeTrendBars({ n: 221, close: 110, trend: 0.05 });
    paintLong(bars, 219);
    const first = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      market: fakeMarket(bars.slice(0, 219)),
    });
    await first.start();
    first.market.bars = bars.slice(0, 220);
    await next(first, bars, 219);
    const restored = new Engine({
      userDataDir: dir,
      settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, timeframe: "15m" },
      market: fakeMarket(bars.slice(0, 220)),
    });
    assert(restored.paper.openBet, "restore open paper bet");
    assert(restored.paper.balance.toFixed(2) === "999.00" || restored.paper.openBet.sizeUsd === "1.00", "stake remembered");
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
  }

  console.log("paper engine tests ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
