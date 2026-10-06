"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { HISTORY_BARS, INTERVAL_MS } = require("./markets");
const { MarketData } = require("./marketData");

const interval = INTERVAL_MS["15m"];
function row(openTs, close, closeTs = openTs + interval - 1) {
  return [openTs, String(close), String(close), String(close), String(close), "1", closeTs];
}
function kline(openTs, close, closed = true) {
  return { t: openTs, o: String(close), h: String(close), l: String(close), c: String(close), v: "1", T: openTs + interval - 1, x: closed };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function market(fetchJson = async () => [row(0, 1)]) {
  return new MarketData({ fetchJson, webSocketImpl: FakeWebSocket });
}

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
  }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ping() {}
  pong() {}
}

async function run() {
  {
    const md = market(async () => { throw new Error("offline"); });
    md.bars = [{ openTs: 0, close: 12 }];
    md.forming = { openTs: interval, close: 13 };
    md._wsClosedBars.set(0, md.bars[0]);
    md._wsSignalledBars.add(0);
    await assert.rejects(md.configure({ symbol: "ETHUSDT", timeframe: "5m", refreshMs: 2000 }), /offline/);
    assert.strictEqual(md.symbol, "BTCUSDT");
    assert.strictEqual(md.timeframe, "15m");
    assert.strictEqual(md.refreshMs, 100);
    assert.strictEqual(md.bars[0].close, 12);
    assert.strictEqual(md.forming.close, 13);
    assert.strictEqual(md._wsClosedBars.get(0).close, 12);
    assert.ok(md._wsSignalledBars.has(0));
    md.stop();
  }
  // A REST response that finishes after stop cannot repopulate cleared state.
  {
    const pending = deferred();
    const md = market(() => pending.promise);
    const loading = md.loadHistory();
    md.stop();
    pending.resolve([row(0, 7)]);
    await loading;
    assert.deepStrictEqual(md.bars, []);
  }

  // Configure invalidates old-symbol work before it can overwrite new state.
  {
    const pending = deferred();
    const md = market((url) => url.includes("symbol=BTCUSDT") ? pending.promise : Promise.resolve([row(0, 9)]));
    const loading = md.loadHistory();
    const configuring = md.configure({ symbol: "ETHUSDT" });
    pending.resolve([row(0, 7)]);
    await loading;
    await configuring;
    assert.strictEqual(md.symbol, "ETHUSDT");
    assert.strictEqual(md.bars[0].close, 9, "only the new-symbol history is applied");
    md.stop();
  }

  // A closed websocket candle wins over an overlapping, older REST snapshot.
  {
    const pending = deferred();
    const md = market(() => pending.promise);
    const loading = md.loadHistory();
    md._applyKline(kline(10 * interval, 42));
    pending.resolve([row(0, 1), row(10 * interval, 2)]);
    await loading;
    assert.strictEqual(md.bars.find((bar) => bar.openTs === 10 * interval).close, 42);
    assert.strictEqual(md.bars[md.bars.length - 1].closed, true);
  }

  // Authoritative close replaces an existing row, and retained bar history is bounded.
  {
    const md = market();
    md.bars = Array.from({ length: HISTORY_BARS }, (_, i) => ({ openTs: i * interval, close: 1, closed: true }));
    md._applyKline(kline((HISTORY_BARS - 1) * interval, 5));
    assert.strictEqual(md.bars.length, HISTORY_BARS);
    assert.strictEqual(md.bars.at(-1).close, 5);
    md._applyKline(kline(HISTORY_BARS * interval, 6));
    assert.strictEqual(md.bars.length, HISTORY_BARS);
    assert.strictEqual(md.bars.at(-1).openTs, HISTORY_BARS * interval);
  }

  // A history gap updates the chart but never replays stale close signals.
  {
    const md = market();
    const emitted = [];
    md.on((event, bar) => { if (event === "bar_close") emitted.push(bar); });
    md.bars = [row(0, 1)].map(([openTs, , , , close, , closeTs]) => ({ openTs, close: Number(close), closeTs, closed: true }));
    md.bars.push({ openTs: interval, close: 2, closeTs: 2 * interval - 1, closed: true });
    md.forming = { openTs: 2 * interval, close: 3, closed: false };
    md._emitReconciledClose(0);
    assert.deepStrictEqual(emitted, [{ ...md.bars[1], recovered: true }], "REST catchup marks the latest newly closed candle recovered");

    emitted.length = 0;
    md._emitReconciledClose(interval);
    assert.deepStrictEqual(emitted, [], "repeated reconciliation does not replay a recovered close");

    md.bars.push({ openTs: 3 * interval, close: 4, closed: true });
    md._emitReconciledClose(0);
    assert.deepStrictEqual(emitted, [{ ...md.bars[2], recovered: true }], "a gap recovers only the latest closed candle");
  }

  // Only fresh, contiguous final klines signal; a later partial update cannot reopen one.
  {
    const md = market();
    const emitted = [];
    md.on((event, bar) => { if (event === "bar_close") emitted.push(bar); });
    const now = Date.now();
    const justClosed = Math.floor(now / interval) * interval - interval;
    md.bars = [{ openTs: justClosed - interval, close: 1, closed: true }];
    md._applyKline(kline(justClosed, 2));
    md._applyKline(kline(justClosed, 3, false));
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].recovered, undefined, "live websocket closes retain their original payload");
    assert.strictEqual(md.bars.at(-1).close, 2, "closed candle values remain authoritative");
    assert.strictEqual(md.forming, null, "a partial update cannot reopen a closed candle");

    md._applyKline(kline(justClosed - 10 * interval, 4));
    assert.strictEqual(emitted.length, 1, "old replayed candles do not emit stale signals");
  }

  // If a WS final candle was withheld because of a gap, REST recovery can signal it once.
  {
    const md = market();
    const emitted = [];
    md.on((event, bar) => { if (event === "bar_close") emitted.push(bar); });
    const justClosed = Math.floor(Date.now() / interval) * interval - interval;
    md.bars = [{ openTs: justClosed - 2 * interval, close: 1, closed: true }];
    md._applyKline(kline(justClosed, 2));
    assert.strictEqual(emitted.length, 0, "the websocket close is withheld while its predecessor is absent");
    md._emitReconciledClose(justClosed - 2 * interval);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].recovered, true, "REST recovery marks the withheld candle");
    md._emitReconciledClose(justClosed - 2 * interval);
    assert.strictEqual(emitted.length, 1, "the recovered WS candle is not signalled twice");
  }

  // A forming update for the latest closed REST candle must not reopen it.
  {
    const md = market();
    md.bars = [{ openTs: interval, close: 2, closed: true }];
    md._applyKline(kline(interval, 3, false));
    assert.strictEqual(md.forming, null);
    assert.strictEqual(md.bars[0].close, 2);
  }

  // A real WS final remains signalable when REST already loaded that candle.
  {
    const md = market();
    const emitted = [];
    md.on((event, bar) => { if (event === "bar_close") emitted.push(bar); });
    const justClosed = Math.floor(Date.now() / interval) * interval - interval;
    md.bars = [
      { openTs: justClosed - interval, close: 1, closed: true },
      { openTs: justClosed, close: 2, closed: true },
    ];
    md._applyKline(kline(justClosed, 3));
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].recovered, undefined);
  }

  // Socket errors schedule a reconnect; a connection that never opens is timed out.
  {
    const md = market();
    md._wanted = true;
    md._openWs();
    const first = md.ws;
    const health = [];
    md.on((event, payload) => { if (event === "health") health.push(payload); });
    first.emit("open");
    assert.strictEqual(health.at(-1).state, "connected");
    first.emit("error", new Error("offline"));
    assert.strictEqual(md.ws, null);
    assert.ok(md._reconnectTimer, "socket errors must schedule a reconnect");
    assert.deepStrictEqual(Object.keys(health.at(-1)).sort(), ["at", "host", "reason", "state", "symbol", "timeframe"].sort());
    assert.strictEqual(health.at(-1).state, "reconnecting");
    md.stop();

    const hanging = market();
    hanging.wsConnectTimeoutMs = 5;
    hanging._wanted = true;
    hanging._openWs();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(hanging.ws, null, "a socket handshake must not hang forever");
    assert.ok(hanging._reconnectTimer);
    hanging.stop();
  }

  console.log("market data tests ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
