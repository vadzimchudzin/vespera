"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");
const { computeStats } = require("./stats");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vsp-final-settlement-"));
}

function engineAt(dir, live) {
  const market = { bars: [], timer: null, on() {}, start() { this.timer = true; }, stop() { this.timer = null; } };
  return new Engine({
    userDataDir: dir,
    settings: { mode: "auto", dryRun: false, timeframe: "15m", baseUsd: "1.00" },
    live,
    market,
  });
}

function bet(overrides = {}) {
  return {
    dryRun: false, clientOrderId: "live-final-1", side: "UP", sizeUsd: "10.00",
    entryPrice: 0.5, shares: 20, feeUsd: "0.35", orderId: "order-1",
    tokenId: "token-up", slug: "btc-updown-15m-1", strike: 100, roundOpenTs: 1, roundCloseTs: 2,
    placedAt: 1, status: "open", ...overrides,
  };
}

function liveWith(resolve) {
  return {
    async resolvedOutcome(slug, position) { this.slug = slug; this.position = position; return resolve(); },
    async ping() { return { ok: false }; },
    async getBalance() { return null; },
  };
}

function clearTimer(engine) {
  if (engine._finalReconcileTimer) clearTimeout(engine._finalReconcileTimer);
  engine._finalReconcileTimer = null;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  {
    const dir = tempDir();
    const engine = engineAt(dir, liveWith(() => ({ resolved: false })));
    engine.liveBet = bet();
    const events = [];
    engine.on((event) => { if (event.type === "settled") events.push(event.payload); });
    const provisional = engine._settleLive({ close: 101, closeTs: 2 });
    clearTimer(engine);
    assert.strictEqual(provisional.type, "settlement_provisional");
    assert.strictEqual(engine.risk.step, 1, "Binance provisional result does not change risk");
    assert.strictEqual(engine.liveBet.clientOrderId, "live-final-1", "position remains locked while unresolved");
    assert.strictEqual(engine.snapshot().finalPending.clientOrderId, "live-final-1");
    assert.strictEqual(computeStats(engine.journal.restoreEntries, { book: "live" }).count, 0, "unresolved order is not reported as settled");
    const notReady = await engine.reconcileFinalSettlement({ attempts: 1, delayMs: 0 });
    assert.strictEqual(notReady.ok, false);
    assert.strictEqual(engine.risk.step, 1);
    assert.strictEqual(engine.liveBet.clientOrderId, "live-final-1");
    assert.strictEqual(events.length, 0);
    assert.strictEqual(engine.journal.restoreEntries.filter((row) => row.type === "settled").length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    const engine = engineAt(dir, liveWith(() => ({ resolved: true, outcome: "DOWN" })));
    engine.liveBet = bet();
    engine._settleLive({ close: 101, closeTs: 2 });
    clearTimer(engine);
    const events = [];
    engine.on((event) => { if (event.type === "settled") events.push(event.payload); });
    const final = await engine.reconcileFinalSettlement({ attempts: 1, delayMs: 0 });
    assert.strictEqual(final.ok, true);
    assert.strictEqual(engine.live.position.tokenId, "token-up", "the authoritative lookup receives the persisted position identity");
    assert.strictEqual(final.settled.outcome, "DOWN", "final oracle result corrects a conflicting Binance close");
    assert.strictEqual(final.settled.status, "loss");
    assert.strictEqual(final.settled.pnl, "-10.35");
    assert.strictEqual(final.settled.settlementStatus, "final");
    assert.strictEqual(final.settled.settlementSource, "polymarket");
    assert.strictEqual(engine.risk.step, 2);
    assert.strictEqual(engine.liveBet, null);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(engine.journal.restoreEntries.filter((row) => row.type === "settled" && row.clientOrderId === "live-final-1").length, 1);
    await engine.reconcileFinalSettlement({ attempts: 1, delayMs: 0 });
    assert.strictEqual(events.length, 1, "a repeated reconciliation cannot emit a duplicate final result");
    assert.strictEqual(engine.risk.step, 2, "risk advances exactly once");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    let calls = 0;
    const engine = engineAt(dir, liveWith(() => {
      calls += 1;
      if (calls === 1) throw new Error("temporary REST outage");
      return { resolved: true, outcome: "UP" };
    }));
    engine.liveBet = bet();
    engine._settleLive({ close: 99, closeTs: 2 });
    clearTimer(engine);
    engine.stop();
    const result = await engine.reconcileFinalSettlement({ attempts: 2, delayMs: 0 });
    assert.strictEqual(result.ok, true, "Stop does not suppress the independent final resolver");
    assert.strictEqual(engine.running, false);
    assert.strictEqual(engine.status, "stopped");
    assert.strictEqual(engine.journal.restoreEntries.filter((row) => row.type === "settled").length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    const engine = engineAt(dir, liveWith(() => ({ resolved: false })));
    engine.liveBet = bet({ clientOrderId: "restart-final" });
    engine._settleLive({ close: 101, closeTs: 2 });
    clearTimer(engine);
    const restored = engineAt(dir, liveWith(() => ({ resolved: false })));
    await new Promise((resolve) => setImmediate(resolve));
    clearTimer(restored);
    assert.strictEqual(restored.finalPending.clientOrderId, "restart-final");
    assert.strictEqual(restored.liveBet.clientOrderId, "restart-final", "restart restores the blocking position");
    assert.strictEqual(restored.snapshot().finalPending.provisionalOutcome, "UP");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    const engine = engineAt(dir, liveWith(() => ({ resolved: true, outcome: "DOWN" })));
    engine.liveBet = bet({ clientOrderId: "final-write-retry" });
    engine._settleLive({ close: 101, closeTs: 2 });
    clearTimer(engine);
    const write = engine.journal.write.bind(engine.journal);
    let failAfterCommit = true;
    engine.journal.write = (row) => {
      const result = write(row);
      if (failAfterCommit && row.type === "settled") {
        failAfterCommit = false;
        throw new Error("simulated failure after durable checkpoint");
      }
      return result;
    };
    const result = await engine.reconcileFinalSettlement({ attempts: 1, delayMs: 0 });
    assert.strictEqual(result.ok, true, "idempotent retry observes the committed checkpoint");
    assert.strictEqual(engine.journal.restoreEntries.filter((row) => row.type === "settled" && row.clientOrderId === "final-write-retry").length, 1);
    assert.strictEqual(engine.risk.step, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    const engine = engineAt(dir, liveWith(() => ({ resolved: true, outcome: "UP" })));
    engine.liveBet = bet({ dryRun: true, clientOrderId: "dry-run-now" });
    const immediate = engine._settleLive({ close: 101, closeTs: 2 });
    assert.strictEqual(immediate.status, "win", "dry-run remains immediate on Binance close");
    assert.strictEqual(immediate.settlementStatus, undefined);
    assert.strictEqual(engine.finalPending, null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    const engine = engineAt(dir, liveWith(() => ({ resolved: false })));
    engine.liveBet = bet({ clientOrderId: "dispose-wait" });
    engine._settleLive({ close: 101, closeTs: 2 });
    clearTimer(engine);
    const running = engine.reconcileFinalSettlement({ attempts: 2, delayMs: 60_000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(engine._finalReconcileWait.timer.hasRef(), false, "poll delay does not keep the process alive");
    engine.dispose();
    assert.deepStrictEqual(await running, { ok: false, reason: "disposed" });
    assert.ok(engine.finalPending, "dispose cancels polling without releasing the settlement lock");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = tempDir();
    const outcome = deferred();
    const engine = engineAt(dir, liveWith(() => outcome.promise));
    engine.liveBet = bet({ clientOrderId: "dispose-inflight" });
    engine._settleLive({ close: 101, closeTs: 2 });
    clearTimer(engine);
    const running = engine.reconcileFinalSettlement({ attempts: 1, delayMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    engine.dispose();
    outcome.resolve({ resolved: true, outcome: "UP" });
    assert.deepStrictEqual(await running, { ok: false, reason: "disposed" });
    assert.ok(engine.finalPending, "late venue response after dispose cannot settle a position");
    assert.strictEqual(engine.journal.restoreEntries.filter((row) => row.type === "settled").length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().then(() => console.log("Final settlement tests passed")).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
