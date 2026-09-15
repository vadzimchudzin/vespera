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

{
  const bars = makeBars({ n: 220, close: 110, trend: 0.05 });
  const i = bars.length - 1;
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2);
  const ev = evaluateBar(bars, i);
  assert(ev.signal === "UP", `expected UP got ${ev.signal} ${ev.reason}`);
}

{
  const bars = makeBars({ n: 220, close: 80, trend: -0.05 });
  const i = bars.length - 1;
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 + 2, ma20 + 4, ma20 - 3, ma20 - 2);
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
  const bars = makeBars({ n: 220, close: 110, trend: 0.0001 });
  const i = bars.length - 1;
  const ma20 = sma(
    bars.map((b) => b.close),
    20,
    i
  );
  bars[i] = bar(ma20 - 2, ma20 + 3, ma20 - 4, ma20 + 2);
  const open = evaluateBar(bars, i);
  assert(open.signal === "UP", "default still fires");
  const filtered = evaluateBar(bars, i, { minOpeningAtr: 3 });
  assert(filtered.signal === null, "tight MAs skipped");
  assert(filtered.reason === "ma_opening_too_small", filtered.reason);
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
  assert(p.balance.toFixed(2) === "101.00", "paper payout 2x");

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
