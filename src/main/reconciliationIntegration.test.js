"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("./executionHost");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");
const { orderHash } = require("./brokers/orderSigner");
const { ethers } = require("ethers");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-authority-"));
  let host;
  let seenHash;
  const key = "0x" + "11".repeat(32);
  const maker = new ethers.Wallet(key).address;
  let posts = 0;
  const venue = new PolymarketAdapter({ privateKey: key, walletAddress: maker, apiKey: "test", apiSecret: "cw==", apiPassphrase: "test", client: {
    configure() {},
    async postOrder(signed) { posts += 1; seenHash = orderHash(signed.order); throw new Error("response_lost"); },
    async getOrder(id) {
      assert.equal(id, seenHash);
      return { ok: true, json: { id, side: "BUY", status: "CANCELED", maker_address: maker, asset_id: "123", size_matched: "8", associate_trades: ["fill-one"] } };
    },
    async getTrade(id) { return { ok: true, json: { data: [{ id, taker_order_id: seenHash, asset_id: "123", side: "BUY", trader_side: "TAKER", status: "CONFIRMED", size: "8", price: "0.5", fee_rate_bps: "700" }] } }; },
  } });
  venue.getBalance = async () => null;
  venue.getQuote = async () => ({ ok: true, price: 0.5, feeRate: 0.07, feeExponent: 1 });
  venue._sizeFromSignal = async () => ({ tokenId: "123", makerAmount: "5000000", takerAmount: "10000000", side: 0,
    quote: { side: "UP", slug: "btc-updown-15m-1", sizeUsd: "5.00", price: 0.5, limitPrice: 0.5, shares: 10, feeUsd: "0.175", feeRate: 0.07, feeExponent: 1 } });
  venue.resolvedOutcome = async () => ({ resolved: true, outcome: "DOWN" });
  const options = { market: { bars: [], on() {}, start() {}, stop() {} }, live: venue };
  try {
    host = new ExecutionHost({ userDataDir: dir, engineOptions: options });
    await host.call("saveSettings", [{ mode: "auto", dryRun: false, baseUsd: "5.00", privateKey: key, walletAddress: maker, apiKey: "test", apiSecret: "cw==", apiPassphrase: "test" }]);
    await host.call("setMode", ["auto"]);
    host.engine.running = true;
    await host.engine._openFromSignal({ signal: "UP", reason: "isolated_test" }, { openTs: 0, closeTs: 899999, open: 99, close: 100, high: 101, low: 98 });
    assert.equal(posts, 1);
    const pending = host.engine.journal.pendingOrder();
    assert.equal(pending.evidence.orderId, seenHash);
    assert.equal(pending.evidence.maker.toLowerCase(), maker.toLowerCase());
    assert.equal(pending.evidence.feeExponent, 1);
    assert.ok(!JSON.stringify(pending).includes(key));
    const inspected = await host.call("inspectPendingOrder");
    assert.equal(inspected.ok, true);
    assert.equal(inspected.order.sizeUsd, "4.000000");
    assert.equal(inspected.clientOrderId, pending.clientOrderId);
    const result = await host.call("resolvePendingOrder", [{ clientOrderId: pending.clientOrderId, orderId: seenHash, confirm: true }]);
    assert.equal(result.ok, true);
    assert.equal(posts, 1, "reconciliation never repeats POST");
    assert.equal(host.engine.running, false);
    assert.equal(host.engine.journal.pendingOrder(), null);
    assert.equal(host.engine.liveBet.shares, 8);
    assert.equal(host.engine.liveBet.tokenId, "123", "restored live position retains its market token identity");
    assert.equal(Number(host.engine.liveBet.feeUsd), 0.14);
    host.dispose();
    host = new ExecutionHost({ userDataDir: dir, engineOptions: options });
    assert.equal(host.engine.liveBet.tokenId, "123", "restart keeps the token identity required for final resolution");
    host.engine._settleLive({ closeTs: 1799999, close: 101 });
    assert.equal(host.engine.risk.step, 1, "Binance UP is still provisional");
    const settled = await host.call("reconcileFinalSettlement");
    assert.equal(settled.ok, true);
    assert.equal(host.engine.risk.step, 2, "venue DOWN applies loss, unlike provisional UP");
    const history = host.engine.journal.readAll().filter((row) => row.type === "settled");
    assert.equal(history.length, 1);
    assert.equal(history[0].pnl, "-4.14");
    host.dispose();
    host = new ExecutionHost({ userDataDir: dir, engineOptions: options });
    assert.equal(host.engine.liveBet, null);
    assert.equal(host.engine.finalPending, null);
    assert.equal(host.engine.risk.step, 2);
    console.log("Broker/journal/host reconciliation integration tests ok");
  } finally {
    host?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
