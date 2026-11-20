"use strict";

/**
 * Resting limit entries: the order sits on the book for a hold window, is
 * withdrawn when it does not fill, and is never forgotten across a restart.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");

const HASH = `0x${"a".repeat(64)}`;
const dirs = [];

function dir() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-resting-"));
  dirs.push(value);
  return value;
}

const signal = { signal: "UP", reason: "test" };
const bar = { openTs: 0, closeTs: 0, open: 100, close: 101, high: 102, low: 99 };

function engine(overrides = {}) {
  return new Engine({
    userDataDir: dir(),
    holdPollMs: 1,
    settings: { mode: "auto", dryRun: false, baseUsd: "5.00", maxSteps: 6, entryStyle: "limit", holdSeconds: 5 },
    market: { bars: [], on() {}, start() {}, stop() {} },
    live: {
      hasPrivateKey() { return true; },
      async getQuote() { return { ok: true, price: 0.5, minOrderSize: 5, asks: [{ price: "0.5", size: "100" }] }; },
      async marketBuy(p) {
        return { ok: true, live: true, resting: true, orderId: HASH, sizeUsd: p.sizeUsd, shares: 10, limitPrice: 0.5, price: 0.5, tokenId: "t1", slug: "s1" };
      },
      ...overrides,
    },
  });
}

/** A round that closes 10s + slack from now, so the hold deadline is a few ms away. */
function roundBar(slackMs = 60) {
  const closeTs = Date.now() + 10000 + slackMs;
  return { ...bar, openTs: closeTs - 300000, closeTs };
}

function bets(e) {
  return e.markers.filter((m) => !m.virtual);
}

async function run() {
  // A resting entry that fills inside the window is booked, never cancelled.
  {
    let probes = 0;
    const e = engine({
      async probeOrder() {
        probes += 1;
        return probes === 1
          ? { ok: true, status: "LIVE", matched: 0, size: 10 }
          : { ok: true, status: "MATCHED", matched: 10, size: 10 };
      },
      async cancelOrder() { throw new Error("must not cancel a filled order"); },
      async settleResting() {
        return { side: "UP", orderId: HASH, sizeUsd: "5.000000", shares: 10, price: 0.5, entryPrice: 0.5, payout: 2, feeUsd: "0.01", filled: true, partial: false, orderStatus: "MATCHED" };
      },
    });
    e.running = true;
    await e._openFromSignal(signal, roundBar());
    assert.strictEqual(bets(e).length, 1, "the resting fill is booked as a bet");
    assert.strictEqual(e.status, "waiting_settlement");
    assert.ok(e.journal.entries.some((x) => x.type === "order_live" && x.orderId === HASH), "an open resting order is journaled first");
    assert.ok(e.journal.entries.some((x) => x.type === "order_closed" && x.orderId === HASH && x.filled === true));
    assert.ok(!e.journal.entries.some((x) => x.type === "order_cancel"), "a filled order is not withdrawn");
  }

  // An order that never fills is withdrawn at the deadline and the round is skipped.
  {
    const cancelled = [];
    const e = engine({
      async probeOrder() { return { ok: true, status: "LIVE", matched: 0, size: 10 }; },
      async cancelOrder(id) { cancelled.push(id); return { ok: true }; },
      async settleResting() { throw new Error("must not settle an empty order"); },
    });
    e.running = true;
    await e._openFromSignal(signal, roundBar());
    assert.deepStrictEqual(cancelled, [HASH], "the unfilled order is withdrawn exactly once");
    assert.strictEqual(bets(e).length, 0, "nothing is booked");
    assert.strictEqual(e.running, true, "an unfilled limit does not stop the session");
    assert.strictEqual(e.status, "watching");
    assert.ok(e.journal.entries.some((x) => x.type === "order_cancel" && x.ok === true));
    assert.ok(e.journal.entries.some((x) => x.type === "order_closed" && x.filled === false));
    assert.ok(!e.journal.pendingOrder(), "a clean skip leaves no pending order behind");
  }

  // A cancel that fails leaves a live order: the session stops instead of trading blind.
  {
    const e = engine({
      async probeOrder() { return { ok: true, status: "LIVE", matched: 0, size: 10 }; },
      async cancelOrder() { return { ok: false, reason: "cancel_failed_500" }; },
      async settleResting() { throw new Error("unreachable"); },
    });
    e.running = true;
    await e._openFromSignal(signal, roundBar());
    assert.strictEqual(e.running, false, "an order that may still be live pauses the session");
    assert.ok(/order_outcome_unknown/.test(String(e.pauseReason)), e.pauseReason);
    assert.ok(e.journal.entries.some((x) => x.type === "order_cancel" && x.ok === false));
    assert.strictEqual(bets(e).length, 0);
  }

  // A resting order written by an earlier run is withdrawn before anything new opens.
  {
    const root = dir();
    const seed = new Engine({
      userDataDir: root,
      settings: { mode: "auto", dryRun: false, baseUsd: "5.00" },
      market: { bars: [], on() {}, start() {}, stop() {} },
      live: { hasPrivateKey() { return true; }, async getQuote() { return { ok: true, price: 0.5, minOrderSize: 5 }; } },
    });
    seed.journal.write({ type: "order_live", mode: "auto", orderId: HASH, side: "UP", sizeUsd: "5.00", limitPrice: 0.5, shares: 10 });

    let cancelled = 0;
    const e = new Engine({
      userDataDir: root,
      settings: { mode: "auto", dryRun: false, baseUsd: "5.00" },
      market: { bars: [], on() {}, start() {}, stop() {} },
      live: {
        hasPrivateKey() { return true; },
        async getBalance() { return 100; },
        async getQuote() { return { ok: true, price: 0.5, minOrderSize: 5 }; },
        async probeOrder() { return { ok: true, status: "LIVE", matched: 0, size: 10 }; },
        async cancelOrder(id) { cancelled += 1; assert.strictEqual(id, HASH); return { ok: true }; },
      },
    });
    const started = await e.start({ confirmLive: true });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.strictEqual(cancelled, 1, "the leftover order is withdrawn on start");
    assert.ok(e.journal.entries.some((x) => x.type === "order_cancel" && x.reason === "recovered_on_start"));
    e.stop();
  }

  // A fill that happened while the app was down is surfaced, never guessed.
  {
    const root = dir();
    const seed = new Engine({
      userDataDir: root,
      settings: { mode: "auto", dryRun: false, baseUsd: "5.00" },
      market: { bars: [], on() {}, start() {}, stop() {} },
      live: { hasPrivateKey() { return true; }, async getQuote() { return { ok: true, price: 0.5, minOrderSize: 5 }; } },
    });
    seed.journal.write({ type: "order_live", mode: "auto", orderId: HASH, side: "UP", sizeUsd: "5.00", limitPrice: 0.5, shares: 10 });

    let cancelled = 0;
    const e = new Engine({
      userDataDir: root,
      settings: { mode: "auto", dryRun: false, baseUsd: "5.00" },
      market: { bars: [], on() {}, start() {}, stop() {} },
      live: {
        hasPrivateKey() { return true; },
        async getBalance() { return 100; },
        async getQuote() { return { ok: true, price: 0.5, minOrderSize: 5 }; },
        async probeOrder() { return { ok: true, status: "MATCHED", matched: 10, size: 10 }; },
        async cancelOrder() { cancelled += 1; return { ok: true }; },
      },
    });
    const started = await e.start({ confirmLive: true });
    assert.strictEqual(started.ok, false, "a recovered fill blocks a silent fresh start");
    assert.strictEqual(started.reason, "resting_order_recovered");
    assert.strictEqual(cancelled, 0, "a filled order is not cancelled");
    assert.ok(/resting_order_recovered/.test(String(e.pauseReason)));
    assert.ok(e.journal.entries.some((x) => x.type === "order_recovered_fill" && x.matched === 10));
  }

  // Adapter: a GTC answers with a hash, and a missing hash is an unknown outcome.
  {
    const venue = new PolymarketAdapter({
      apiKey: "k", apiSecret: Buffer.from("s").toString("base64"), apiPassphrase: "p",
      walletAddress: "0x1111111111111111111111111111111111111111",
      privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      slippage: 0,
      client: {
        configure() {},
        async balanceAllowance() { return { ok: true, status: 200, json: { balance: "50000000" } }; },
        async postOrder() { return { ok: true, status: 200, json: { success: true, orderID: HASH, status: "live" } }; },
        async getOrder() { return { ok: true, status: 200, json: { id: HASH, status: "LIVE", size_matched: "0", original_size: "10" } }; },
        async cancelOrder() { return { ok: true, status: 200, json: { canceled: [HASH] } }; },
      },
    });
    venue.getQuote = async () => ({ ok: true, price: 0.5, tickSize: 0.01, minOrderSize: 5, feeRate: 0.07, feeExponent: 1, asks: [{ price: "0.5", size: "100" }], tokenId: "12345678901234567890", slug: "s1" });
    const placed = await venue.marketBuy({ side: "UP", sizeUsd: "5.00", round: { openTs: 1 }, orderType: "GTC" });
    assert.strictEqual(placed.live, true);
    assert.strictEqual(placed.orderId, HASH);
    assert.strictEqual(placed.filled, false, "a resting order is not a fill");
    const probe = await venue.probeOrder(HASH);
    assert.deepStrictEqual([probe.status, probe.matched], ["LIVE", 0]);
    assert.strictEqual((await venue.cancelOrder(HASH)).ok, true);

    venue.client.postOrder = async () => ({ ok: true, status: 200, json: { success: true } });
    await assert.rejects(
      () => venue.marketBuy({ side: "UP", sizeUsd: "5.00", round: { openTs: 1 }, orderType: "GTC" }),
      (err) => err.code === "order_outcome_unknown" && err.ambiguous === true,
      "a resting order without a hash is ambiguous, never assumed filled"
    );
  }

  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
  console.log("resting order tests ok");
}

run().catch((err) => {
  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
