"use strict";

const { evaluateBar, sma } = require("./strategy");
const { Risk } = require("./risk");
const { PaperBroker } = require("./paperBroker");

function bar(open, high, low, close, extra = {}) {
  return { open, high, low, close, ...extra };
}

function makeBars({ n = 220, close = 100, trend = 0 }) {
  const bars = [];
  let c = close;
  for (let i = 0; i < n; i += 1) {
    c += trend;
    bars.push(bar(c, c + 1, c - 1, c, { openTs: i * 900000 }));
  }
  return bars;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const values = Array.from({ length: 20 }, () => 10);
  assert(sma(values, 20, 19) === 10, "sma flat");
}

function paintLong(bars, i) {
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    i - 1
  );
  bars[i - 1] = bar(ma20Prev - 1, ma20Prev - 0.4, ma20Prev - 2, ma20Prev - 1.2, {
    openTs: bars[i - 1].openTs,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2, { openTs: bars[i].openTs });
}

function paintShort(bars, i) {
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    i - 1
  );
  bars[i - 1] = bar(ma20Prev + 1.2, ma20Prev + 2, ma20Prev + 0.4, ma20Prev + 1, {
    openTs: bars[i - 1].openTs,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 + 2, ma20 + 4, ma20 - 3, ma20 - 2, { openTs: bars[i].openTs });
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  paintLong(bars, i);
  const ev = evaluateBar(bars, i);
  assert(ev.signal === "UP", `expected UP got ${ev.signal} ${ev.reason}`);
}

{
  const bars = makeBars({ n: 220, close: 80, trend: -0.05 });
  const i = bars.length - 1;
  paintShort(bars, i);
  const ev = evaluateBar(bars, i);
  assert(ev.signal === "DOWN", `expected DOWN got ${ev.signal} ${ev.reason}`);
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 + 2, ma20 + 4, ma20 - 3, ma20 - 2);
  const ev = evaluateBar(bars, i);
  assert(ev.signal === null, "no short above MA200");
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    i - 1
  );
  bars[i - 1] = bar(ma20Prev + 3, ma20Prev + 4, ma20Prev + 2, ma20Prev + 3, {
    openTs: bars[i - 1].openTs,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2, { openTs: bars[i].openTs });
  const ev = evaluateBar(bars, i);
  assert(ev.signal === null, `no long without prior pullback got ${ev.signal} ${ev.reason}`);
  assert(ev.reason === "no_pullback_down", ev.reason);
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.0001 });
  const i = bars.length - 1;
  paintLong(bars, i);
  const open = evaluateBar(bars, i);
  assert(open.signal === "UP", "default still fires");
  const filtered = evaluateBar(bars, i, { minOpeningAtr: 3 });
  assert(filtered.signal === null, "tight MAs skipped");
  assert(filtered.reason === "ma_opening_too_small", filtered.reason);
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    i - 1
  );
  bars[i - 1] = bar(ma20Prev + 1, ma20Prev + 1.5, ma20Prev - 2, ma20Prev + 0.4, {
    openTs: bars[i - 1].openTs,
  });
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2, { openTs: bars[i].openTs });
  const ev = evaluateBar(bars, i);
  assert(ev.signal === null, `wick-only pullback must not fire got ${ev.signal} ${ev.reason}`);
  assert(ev.reason === "no_pullback_down", ev.reason);
}

function paintLongTicks(bars, i, nTicks, tickSize) {
  const ma20Prev = sma(
    bars.map((b) => b.close),
    20,
    i - 1
  );
  bars[i - 1] = bar(ma20Prev - 1, ma20Prev - 0.4, ma20Prev - 2, ma20Prev - 1.2, {
    openTs: bars[i - 1].openTs,
  });
  let sum19 = 0;
  for (let k = i - 19; k < i; k += 1) sum19 += bars[k].close;
  const close = (nTicks * tickSize * 20 + sum19) / 19;
  const ma20 = (sum19 + close) / 20;
  bars[i] = bar(ma20 - nTicks * tickSize, close + tickSize, ma20 - nTicks * tickSize, close, {
    openTs: bars[i].openTs,
  });
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  const tick = 0.0001;
  paintLongTicks(bars, i, 3, tick);
  const shallow = evaluateBar(bars, i, { minCrossTicks: 5, tickSize: tick });
  assert(shallow.signal === null, "3-tick cross skipped when min is 5");
  assert(shallow.reason === "cross_too_shallow", shallow.reason);
  const any = evaluateBar(bars, i, { minCrossTicks: 0, tickSize: tick });
  assert(any.signal === "UP", `zero ticks still fires ${any.reason}`);
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  const tick = 0.0001;
  paintLongTicks(bars, i, 5, tick);
  const deep = evaluateBar(bars, i, { minCrossTicks: 5, tickSize: tick });
  assert(deep.signal === "UP", `5-tick close must fire got ${deep.signal} ${deep.reason} ${deep.crossTicks}`);
}

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  paintLongTicks(bars, i, 3, 0.01);
  const btcShallow = evaluateBar(bars, i, { minCrossTicks: 10, tickSize: 0.01 });
  assert(btcShallow.signal === null, "BTC 3 ticks skipped when min is 10");
  paintLongTicks(bars, i, 12, 0.01);
  const btcDeep = evaluateBar(bars, i, { minCrossTicks: 10, tickSize: 0.01 });
  assert(btcDeep.signal === "UP", `BTC 12 ticks must fire got ${btcDeep.signal} ${btcDeep.reason}`);
}

{
  const r = new Risk({ baseUsd: "1.00", maxSteps: 6 });
  assert(r.size().toFixed(2) === "1.00", "base size");
  r.onLoss();
  assert(r.size().toFixed(2) === "2.00", "step 2");
  r.onWin();
  assert(r.step === 1, "reset on win");
  for (let i = 0; i < 6; i += 1) r.onLoss();
  assert(r.halted === true, "halt after 6");
  assert(r.canOpen() === false, "cannot open while halt");
  r.confirmLot("1.00");
  assert(r.halted === false && r.step === 1, "lot confirm resumes");
}

async function paperCases() {
  const p = new PaperBroker({ startingBalance: "100" });
  await p.marketBuy({
    side: "UP",
    sizeUsd: "1.00",
    clientOrderId: "t",
    round: { strike: 100, openTs: 1, closeTs: 2 },
  });
  const win = p.settle({ close: 101 });
  assert(win.status === "win", "paper win");
  assert(p.balance.toFixed(2) === "100.99", `paper payout minus fee ${p.balance.toFixed(2)}`);
  assert(win.feeUsd === "0.01", "0.5% fee");

  await p.marketBuy({
    side: "DOWN",
    sizeUsd: "2.00",
    clientOrderId: "t2",
    round: { strike: 100, openTs: 2, closeTs: 3 },
  });
  const loss = p.settle({ close: 100 });
  assert(loss.status === "loss", "flat is a loss");
}

paperCases().then(() => {
  console.log("strategy tests ok");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
