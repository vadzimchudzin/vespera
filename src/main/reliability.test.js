"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");

const dirs = [];
function dir() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-reliability-"));
  dirs.push(value);
  return value;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function engine(overrides = {}) {
  return new Engine({
    userDataDir: dir(),
    settings: { mode: "auto", dryRun: false, baseUsd: "5", maxSteps: 6 },
    market: { bars: [], on() {}, start() {}, stop() {} },
    live: {
      hasPrivateKey() { return true; },
      async getQuote() { return { ok: true, price: 0.5, minOrderSize: 5 }; },
      async marketBuy(p) { return { ...p, price: 0.5, shares: 10, sizeUsd: p.sizeUsd, orderId: "test-id" }; },
      ...overrides,
    },
  });
}
const bar = { openTs: 0, closeTs: 899999, open: 100, close: 101, high: 102, low: 99 };
const signal = { signal: "UP", reason: "test" };

async function run() {
  // Quote waits cannot allow a second entry or an entry after Stop.
  {
    const quote = deferred();
    let orders = 0;
    const e = engine({
      getQuote() { return quote.promise; },
      async marketBuy() { orders += 1; return {}; },
    });
    e.running = true;
    const first = e._openFromSignal(signal, bar);
    assert.strictEqual(await e._openFromSignal(signal, bar), null);
    assert.strictEqual((await e.testOrder({ confirm: true })).reason, "order_pending");
    await e.setMode("paper");
    assert.strictEqual(e.mode, "auto", "book cannot change during entry");
    e.stop();
    quote.resolve({ ok: true, price: 0.5 });
    await first;
    assert.strictEqual(orders, 0, "Stop invalidates a waiting entry");
  }

  // Unknown POST outcomes survive a restart and block all further orders.
  {
    const e = engine({ async marketBuy() {
      const err = new Error("timeout after sending");
      err.code = "order_outcome_unknown";
      err.ambiguous = true;
      throw err;
    } });
    e.running = true;
    await e._openFromSignal(signal, bar);
    assert.strictEqual(e.status, "paused");
    assert.ok(e.journal.pendingOrder());
    const restarted = new Engine({
      userDataDir: e.userDataDir,
      settings: e.settings,
      market: e.market,
      live: e.live,
    });
    assert.strictEqual((await restarted.start({ confirmLive: true })).reason, "order_outcome_unknown");
    assert.strictEqual((await restarted.testOrder({ confirm: true })).reason, "order_pending");
  }

  {
    const e = engine({ async marketBuy() {
      const err = new Error("insufficient balance");
      err.code = "insufficient_balance";
      throw err;
    } });
    e.running = true;
    await e._openFromSignal(signal, bar);
    assert.strictEqual(e.journal.pendingOrder(), null, "definite preflight refusal clears intent");
    assert.strictEqual(e.status, "paused");
  }

  // If recording an accepted bet fails, the durable intent remains locked.
  {
    const e = engine();
    const write = e.journal.write.bind(e.journal);
    e.journal.write = (entry) => {
      if (entry.type === "order_sent") throw new Error("disk failure");
      return write(entry);
    };
    e.running = true;
    await e._openFromSignal(signal, bar);
    assert.ok(e.journal.pendingOrder());
    assert.strictEqual(e.status, "paused");
  }

  // Candle events are processed serially, including REST gap recovery.
  {
    const e = engine();
    const wait = deferred();
    const seen = [];
    e._processBarClose = async (b) => {
      seen.push(b.openTs);
      if (b.openTs === 1) await wait.promise;
    };
    const first = e.onBarClose({ openTs: 1 });
    const second = e.onBarClose({ openTs: 2 });
    await Promise.resolve();
    assert.deepStrictEqual(seen, [1]);
    wait.resolve();
    await Promise.all([first, second]);
    assert.deepStrictEqual(seen, [1, 2]);
  }

  {
    const e = engine();
    e.running = true;
    await e.onBarClose({ ...bar, recovered: true });
    assert.ok(e.journal.entries.some((r) => r.reason === "expired_recovered_signal"));
    assert.strictEqual(e.liveBet, null);
  }

  // Settlement after an outage must use the original round, never a newer close.
  {
    const e = engine();
    const target = { ...bar, openTs: 900000, closeTs: 1799999, close: 99 };
    e.market.bars = [target];
    e.liveBet = { side: "UP", sizeUsd: "5", strike: 100, shares: 10, roundCloseTs: target.closeTs };
    const settled = e._settleIfOpen({ ...target, closeTs: 2699999, close: 110 });
    assert.strictEqual(settled.status, "loss");
    assert.strictEqual(settled.settleClose, 99);
  }

  // Network-only pauses recover; manual Stop cancels a health request in flight.
  {
    let healthy = false;
    const e = engine({
      async health() { return { ok: healthy, reason: "timeout" }; },
      async region() { return { ok: true, blocked: false }; },
    });
    e.running = true;
    e._startHealth();
    for (let i = 0; i < 3; i += 1) await e._healthTick();
    assert.strictEqual(e.running, false);
    assert.ok(e._healthTimer, "health checks continue during a temporary outage");
    healthy = true;
    await e._healthTick();
    assert.strictEqual(e.running, true);
    const wait = deferred();
    e.live.health = () => wait.promise;
    const check = e._healthTick();
    e.stop();
    wait.resolve({ ok: true });
    await check;
    assert.strictEqual(e.running, false);
    assert.strictEqual(e._healthTimer, null);
  }

  // Recovery cannot race a test bet while its region check is pending.
  {
    const wait = deferred();
    const e = engine({
      async health() { return { ok: true }; },
      region() { return wait.promise; },
    });
    e.pauseReason = "venue_down: timeout";
    const recovering = e._healthTick();
    await Promise.resolve();
    const tested = await e.testOrder({ confirm: true });
    assert.strictEqual(tested.ok, true);
    wait.resolve({ ok: true, blocked: false });
    await recovering;
    assert.strictEqual(e.running, false, "a test order during region checking prevents resume");
    assert.strictEqual(await e._openFromSignal(signal, bar), null, "test position prevents strategy overlap");
    const restarted = new Engine({ userDataDir: e.userDataDir, settings: e.settings, market: e.market, live: e.live });
    assert.strictEqual((await restarted.start({ confirmLive: true })).reason, "test_open_bet");
  }

  {
    const e = engine();
    e.settings.fastPeriod = 2;
    e.settings.slowPeriod = 5;
    e.running = true;
    e.market.bars = [0, 1, 2, 4, 5, 6].map((i) => ({ ...bar, openTs: i * 900000, closeTs: (i + 1) * 900000 - 1 }));
    await e.onBarClose(e.market.bars.at(-1));
    assert.ok(e.journal.entries.some((r) => r.reason === "history_gap"));
    assert.strictEqual(e.liveBet, null);
  }

  {
    let posts = 0;
    const venue = new PolymarketAdapter({
      privateKey: "0x" + "11".repeat(32),
      walletAddress: "0x1111111111111111111111111111111111111111",
      apiKey: "test", apiSecret: "cw==", apiPassphrase: "test",
      client: { configure() {}, async postOrder() { posts += 1; } },
    });
    await assert.rejects(
      venue.marketBuy({ tokenId: "1", makerAmount: "5000000", takerAmount: "10000000", isActive: () => false }),
      (err) => err.code === "execution_changed" && !err.ambiguous
    );
    assert.strictEqual(posts, 0, "cancellation is checked inside the adapter before POST");
  }

  // Both a transport exception and an HTTP 5xx after POST are ambiguous.
  for (const reply of [null, { ok: false, status: 0 }, { ok: false, status: 503 }]) {
    const venue = new PolymarketAdapter({
      privateKey: "0x" + "11".repeat(32),
      walletAddress: "0x1111111111111111111111111111111111111111",
      apiKey: "test", apiSecret: "cw==", apiPassphrase: "test",
      client: { configure() {}, async postOrder() {
        if (!reply) throw new Error("socket closed");
        return reply;
      } },
    });
    await assert.rejects(
      venue.marketBuy({ tokenId: "1", makerAmount: "5000000", takerAmount: "10000000" }),
      (err) => err.code === "order_outcome_unknown" && err.ambiguous === true
    );
  }
  console.log("reliability tests ok");
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
});
