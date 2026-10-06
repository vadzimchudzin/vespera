"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");

function makeEngine(dir, live) {
  const market = {
    bars: [], timer: null,
    on() {},
    start() { this.timer = true; },
    stop() { this.timer = null; },
  };
  return new Engine({
    userDataDir: dir,
    settings: { mode: "auto", dryRun: false, timeframe: "15m", baseUsd: "1.00" },
    live,
    market,
  });
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vsp-order-reconcile-"));
}

function fill(overrides = {}) {
  return {
    side: "UP", sizeUsd: "2.25", price: 0.45, shares: 5,
    feeUsd: "0.02", orderId: "venue-order-1", tokenId: "token-up",
    slug: "btc-updown-15m-1", ...overrides,
  };
}

function liveFor(inspection) {
  return {
    async inspectOrder(pending) {
      this.inspected = pending;
      return inspection;
    },
    async ping() { return { ok: false }; },
    async getBalance() { return null; },
  };
}

async function run() {
  {
    const dir = temporaryDirectory();
    const live = liveFor({ ok: false, reason: "not_found" });
    let engine = makeEngine(dir, live);
    const intent = {
      clientOrderId: "unknown-1", mode: "auto", side: "UP", sizeUsd: "5.00",
      round: { strike: 100, openTs: 10, closeTs: 20 }, strike: 100,
      roundOpenTs: 10, roundCloseTs: 20, feeRate: 0.02, feeExponent: 2,
    };
    engine.journal.beginOrder(intent);
    const before = JSON.stringify(engine.journal.pendingOrder());
    assert.deepStrictEqual(await engine.inspectPendingOrder(), { ok: false, reason: "not_found" });
    assert.strictEqual(JSON.stringify(engine.journal.pendingOrder()), before, "inspection never changes pending state");
    assert.strictEqual(live.inspected.clientOrderId, intent.clientOrderId);
    assert.deepStrictEqual(await engine.resolvePendingOrder({ clientOrderId: intent.clientOrderId, orderId: "venue-order-1", confirm: true }),
      { ok: false, reason: "not_found" });
    assert.ok(engine.journal.pendingOrder(), "404/not-found stays blocked");

    engine = makeEngine(dir, live);
    assert.strictEqual(engine.journal.pendingOrder().clientOrderId, intent.clientOrderId, "unknown intent restores after restart");
    assert.strictEqual(engine.liveBet, null, "unknown intent is not guessed to be filled");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temporaryDirectory();
    const pending = {
      clientOrderId: "unknown-partial", mode: "auto", side: "UP", sizeUsd: "5.00",
      round: { strike: 100, openTs: 100, closeTs: 200 }, strike: 100,
      roundOpenTs: 100, roundCloseTs: 200, feeRate: 0.02, feeExponent: 2,
    };
    const engine = makeEngine(dir, liveFor({
      ok: true, kind: "filled", order: fill(),
      evidence: { orderId: "venue-order-1", status: "MATCHED", checkedAt: "now" },
    }));
    engine.journal.beginOrder(pending);
    engine._pauseUnknownOrder();
    const result = await engine.resolvePendingOrder({ clientOrderId: pending.clientOrderId, orderId: "venue-order-1", confirm: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(engine.running, false, "resolution requires manual Start");
    assert.strictEqual(engine.pauseReason, null, "only a restored fill clears unknown-order pause");
    assert.strictEqual(engine.liveBet.sizeUsd, "2.25", "partial fill records actual filled amount");
    assert.strictEqual(engine.liveBet.roundCloseTs, 200, "restored fill retains its intended round");
    assert.strictEqual(engine.journal.pendingOrder(), null);
    const row = engine.journal.restoreEntries.find((entry) => entry.type === "order_sent" && entry.clientOrderId === pending.clientOrderId);
    assert.strictEqual(row.shares, 5);
    assert.strictEqual(row.feeUsd, "0.02");

    const restored = makeEngine(dir, liveFor({ ok: false, reason: "not_found" }));
    assert.strictEqual(restored.liveBet.orderId, "venue-order-1", "filled order state restores from journal");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temporaryDirectory();
    const pending = { clientOrderId: "no-evidence", mode: "auto", side: "UP", sizeUsd: "1.00" };
    const engine = makeEngine(dir, liveFor({ ok: true, kind: "filled", order: fill(), evidence: null }));
    engine.journal.beginOrder(pending);
    const result = await engine.resolvePendingOrder({ clientOrderId: pending.clientOrderId, orderId: "venue-order-1", confirm: true });
    assert.deepStrictEqual(result, { ok: false, reason: "not_filled" });
    assert.ok(engine.journal.pendingOrder(), "fill without evidence fails closed");
    assert.strictEqual(engine.liveBet, null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temporaryDirectory();
    const pending = {
      clientOrderId: "write-failure", mode: "auto", side: "UP", sizeUsd: "5.00",
      round: { strike: 100, openTs: 10, closeTs: 20 }, strike: 100,
      roundOpenTs: 10, roundCloseTs: 20,
    };
    const engine = makeEngine(dir, liveFor({
      ok: true, kind: "filled", order: fill(), evidence: { orderId: "venue-order-1", status: "MATCHED" },
    }));
    engine.journal.beginOrder(pending);
    const write = engine.journal.write.bind(engine.journal);
    let throwAfterDurableCheckpoint = true;
    engine.journal.write = (entry) => {
      const row = write(entry);
      if (throwAfterDurableCheckpoint && entry.type === "order_sent") {
        throwAfterDurableCheckpoint = false;
        throw new Error("simulated append failure after checkpoint");
      }
      return row;
    };
    const result = await engine.resolvePendingOrder({ clientOrderId: pending.clientOrderId, orderId: "venue-order-1", confirm: true });
    assert.strictEqual(result.ok, true, "checkpointed fill survives an append exception");
    assert.strictEqual(engine.journal.restoreEntries.filter((entry) => entry.type === "order_sent" && entry.clientOrderId === pending.clientOrderId).length, 1,
      "retry boundary does not duplicate durable order");
    assert.strictEqual(engine.journal.pendingOrder(), null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temporaryDirectory();
    const pending = { clientOrderId: "test-recovery", mode: "auto", side: "DOWN", sizeUsd: "3.00", test: true, roundCloseTs: 300 };
    const engine = makeEngine(dir, liveFor({
      ok: true, kind: "filled", order: fill({ side: "DOWN" }),
      evidence: { orderId: "venue-order-1", status: "MATCHED" },
    }));
    engine.journal.beginOrder(pending);
    const result = await engine.resolvePendingOrder({ clientOrderId: pending.clientOrderId, orderId: "venue-order-1", confirm: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(engine.lastTestOrder.clientOrderId, pending.clientOrderId);
    assert.ok(engine.journal.restoreEntries.some((entry) => entry.type === "test_order" && entry.clientOrderId === pending.clientOrderId));
    assert.strictEqual(engine.liveBet, null, "test order recovery does not become a strategy position");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = temporaryDirectory();
    const engine = makeEngine(dir, liveFor({ ok: false, reason: "network_unavailable" }));
    engine.journal.beginOrder({ clientOrderId: "outage", side: "UP", sizeUsd: "1.00" });
    const result = await engine.resolvePendingOrder({ clientOrderId: "outage", orderId: "any", confirm: true });
    assert.strictEqual(result.ok, false);
    assert.ok(engine.journal.pendingOrder(), "inspection outage preserves the durable lock");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().then(() => console.log("Unknown-order reconciliation engine tests passed")).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
