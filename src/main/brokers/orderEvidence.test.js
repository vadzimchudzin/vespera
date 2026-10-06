"use strict";

const assert = require("node:assert/strict");
const { inspectOrder } = require("./orderEvidence");
const { orderHash, buildOrder, signOrder, exchangeDomain, ORDER_TYPES } = require("./orderSigner");
const { ClobClient } = require("./clobClient");
const { PolymarketAdapter } = require("./polymarketAdapter");
const { ethers } = require("ethers");

const hash = "0x" + "a".repeat(64);
const maker = "0x" + "1".repeat(40);
const pending = { side: "UP", prepared: { orderId: hash, maker, tokenId: "123", slug: "btc-updown-15m-1", sizeUsd: "5", limitPrice: 0.6, feeRate: 0.07, feeExponent: 1 } };
const order = { id: hash, maker_address: maker, asset_id: "123", side: "BUY", status: "MATCHED", size_matched: "10", associate_trades: ["t1", "t2"] };
const trades = [0.4, 0.5].map((price, i) => ({ id: `t${i + 1}`, taker_order_id: hash, asset_id: "123", side: "BUY", trader_side: "TAKER", status: "CONFIRMED", size: "5", price: String(price), fee_rate_bps: "700" }));
function client(overrides = {}) {
  return { async getOrder() { return { ok: true, json: order }; }, async getTrade(id) { return { ok: true, json: { data: trades.filter((t) => t.id === id) } }; }, ...overrides };
}
async function run() {
  const fill = await inspectOrder(client(), pending, maker);
  assert.equal(fill.ok, true);
  assert.equal(fill.order.sizeUsd, "4.500000");
  assert.equal(fill.order.shares, 10);
  assert.equal(fill.order.price, 0.45);
  assert.equal(fill.order.feeUsd, "0.17150", "sum per-fill fees, not fee at average price");
  assert.equal(fill.order.partial, true);
  assert.equal((await inspectOrder(client(), {}, maker)).reason, "order_hash_unavailable");
  assert.equal((await inspectOrder(client(), pending, "0x" + "2".repeat(40))).reason, "order_identity_mismatch");
  assert.equal((await inspectOrder(client({ async getOrder() { return { ok: false, status: 404 }; } }), pending, maker)).reason, "order_not_found_unproven");
  for (const [change, reason] of [
    [{ status: "LIVE" }, "order_not_terminal"], [{ size_matched: "0" }, "order_fill_unproven"],
    [{ asset_id: "other" }, "order_identity_mismatch"], [{ size_matched: "11" }, "trade_evidence_incomplete"],
  ]) assert.equal((await inspectOrder(client({ async getOrder() { return { ok: true, json: { ...order, ...change } }; } }), pending, maker)).reason, reason);
  for (const [change, reason] of [
    [{ status: "MINED" }, "trade_not_final"], [{ taker_order_id: "other" }, "trade_identity_mismatch"],
    [{ price: "0.7" }, "trade_amount_invalid"], [{ fee_rate_bps: null }, "order_fee_unproven"],
    [{ fee_rate_bps: "30" }, "order_fee_schedule_mismatch"], [{ size: "5000000" }, "trade_evidence_incomplete"],
  ]) assert.equal((await inspectOrder(client({ async getTrade(id) { return { ok: true, json: [{ ...trades.find((t) => t.id === id), ...change }] }; } }), pending, maker)).reason, reason);

  const requests = [];
  const clob = new ClobClient({ apiKey: "test", apiSecret: "cw==", apiPassphrase: "test", walletAddress: maker,
    request: async (url) => { requests.push(url); return { ok: true, json: {} }; } });
  await clob.getOrder(hash);
  await clob.getTrade("trade/?id", maker);
  assert.ok(requests[0].endsWith(`/data/order/${hash}`));
  assert.ok(requests[1].includes("id=trade%2F%3Fid") && requests[1].includes("maker_address="));
  await assert.rejects(clob.getOrder("other"), /invalid_order_hash/);

  const key = "0x" + "11".repeat(32);
  const signer = new ethers.Wallet(key).address;
  for (const signatureType of [0, 1, 2, 3]) {
    const unsigned = buildOrder({ maker: signer, signer, tokenId: "123", makerAmount: "5000000", takerAmount: "10000000", side: 0, signatureType });
    const signed = await signOrder(unsigned, key);
    const message = { ...signed.order };
    delete message.expiration;
    assert.equal(orderHash(unsigned), ethers.utils._TypedDataEncoder.hash(exchangeDomain(false), ORDER_TYPES, message));
    assert.match(orderHash(unsigned, { negRisk: true }), /^0x[a-f0-9]{64}$/);
    assert.notEqual(orderHash(unsigned), orderHash(unsigned, { negRisk: true }));
  }

  let posts = 0;
  const venue = new PolymarketAdapter({ privateKey: key, walletAddress: signer, apiKey: "test", apiSecret: "cw==", apiPassphrase: "test", client: {
    configure() {}, async postOrder() { posts += 1; return { ok: true, status: 200, json: { orderID: hash } }; },
  } });
  await assert.rejects(venue.marketBuy({ tokenId: "123", makerAmount: "5000000", takerAmount: "10000000", side: 0,
    onPrepared: async (evidence) => { assert.match(evidence.orderId, /^0x[a-f0-9]{64}$/); throw new Error("disk_failure"); } }), /disk_failure/);
  assert.equal(posts, 0, "intent evidence must persist before POST");
  let active = true;
  await assert.rejects(venue.marketBuy({ tokenId: "123", makerAmount: "5000000", takerAmount: "10000000", side: 0,
    isActive: () => active, onPrepared: async () => { active = false; } }), /execution_changed/);
  assert.equal(posts, 0, "Stop during durable preparation prevents POST");
  venue._sizeFromSignal = async () => ({ tokenId: "123", makerAmount: "5000000", takerAmount: "10000000", side: 0,
    quote: { sizeUsd: "5.00", limitPrice: 0.5, price: 0.5, feeUsd: "0.175", feeRate: 0.07, feeExponent: 1, side: "UP", slug: "round" } });
  venue.getBalance = async () => null;
  await assert.rejects(venue.marketBuy({ side: "UP", sizeUsd: "5" }), (error) => error.ambiguous === true && error.code === "order_outcome_unknown", "successful response without filled amounts cannot substitute the quote");
  assert.equal(posts, 1);
  console.log("Authoritative order evidence tests ok");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
