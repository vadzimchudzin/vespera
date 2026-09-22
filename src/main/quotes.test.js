"use strict";

/**
 * Covers what the live-quote work changed:
 *  - EMA series and the maType switch in the strategy
 *  - paper settlement on the real Polymarket payout instead of a flat x2
 *  - order sizing, min-size rejection and the unsupported-timeframe guard
 */

const assert = require("assert");
const { sma, smaSeries, emaSeries, maTypeOf, evaluateBar } = require("./strategy");
const { PaperBroker } = require("./paperBroker");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");
const { isSupportedTimeframe, resolveUpDown } = require("./brokers/polymarketMarkets");

// ── moving averages ──────────────────────────────────────────────────────────

const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

assert.deepStrictEqual(
  smaSeries(closes, 3).slice(0, 4),
  [null, null, 2, 3],
  "SMA series must match the point-wise sma()"
);
for (let i = 0; i < closes.length; i += 1) {
  assert.strictEqual(smaSeries(closes, 4)[i], sma(closes, 4, i), "series and sma() must agree");
}

const e = emaSeries(closes, 3);
assert.strictEqual(e[0], null);
assert.strictEqual(e[1], null);
assert.strictEqual(e[2], 2, "EMA seeds on the SMA of the first period");
assert.strictEqual(e[3], 4 * 0.5 + 2 * 0.5, "EMA steps with k = 2/(period+1)");
// On a step up, EMA reacts faster than SMA — that is the point of the option.
const step = [10, 10, 10, 10, 10, 20];
assert.ok(
  emaSeries(step, 3)[5] > smaSeries(step, 3)[5],
  "EMA must react to a jump faster than SMA"
);

assert.strictEqual(maTypeOf({}), "SMA", "SMA stays the default");
assert.strictEqual(maTypeOf({ maType: "ema" }), "EMA");
assert.strictEqual(maTypeOf({ maType: "nonsense" }), "SMA");

// EMA must actually reach the strategy, not just the chart.
function bar(open, close) {
  return { openTs: 0, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close };
}
const bars = [];
for (let i = 0; i < 40; i += 1) bars.push(bar(100 + i, 101 + i));
const withSma = evaluateBar(bars, bars.length - 1, { fastPeriod: 5, slowPeriod: 20 });
const withEma = evaluateBar(bars, bars.length - 1, { fastPeriod: 5, slowPeriod: 20, maType: "EMA" });
assert.notStrictEqual(withSma.ma20, withEma.ma20, "maType must change the fast line");
assert.ok(Number.isFinite(withEma.ma20) && Number.isFinite(withEma.ma200), "EMA lines are numeric");

// ── real payout instead of a flat x2 ─────────────────────────────────────────

async function payoutCase({ payout, side, settleClose, expectPnl, label }) {
  const broker = new PaperBroker({ startingBalance: "100.00", feeRate: 0 });
  await broker.marketBuy({
    side,
    sizeUsd: "10.00",
    clientOrderId: "t1",
    round: { strike: 100, openTs: 1, closeTs: 2 },
    payout,
    price: payout ? 1 / payout : null,
  });
  const settled = broker.settle({ close: settleClose, closeTs: 2 });
  assert.strictEqual(settled.pnl, expectPnl, `${label}: expected ${expectPnl}, got ${settled.pnl}`);
  return settled;
}

(async () => {
  // Ask 0.70 → payout 1.4286 → a winning $10 returns $4.29, not $10.
  const win = await payoutCase({
    payout: 1 / 0.7,
    side: "UP",
    settleClose: 101,
    expectPnl: "4.29",
    label: "win at 0.70",
  });
  assert.strictEqual(win.status, "win");
  assert.strictEqual(win.balanceAfter, "104.29", "balance follows the real payout");

  // A loss is always the full stake, whatever the price was.
  await payoutCase({
    payout: 1 / 0.7,
    side: "UP",
    settleClose: 99,
    expectPnl: "-10.00",
    label: "loss at 0.70",
  });

  // No quote → the old flat x2 so nothing silently changes offline.
  await payoutCase({
    payout: null,
    side: "UP",
    settleClose: 101,
    expectPnl: "10.00",
    label: "fallback x2",
  });

  // Flat close is still a loss.
  const flat = await payoutCase({
    payout: 1 / 0.7,
    side: "UP",
    settleClose: 100,
    expectPnl: "-10.00",
    label: "flat",
  });
  assert.strictEqual(flat.outcome, "FLAT");

  // ── order sizing ───────────────────────────────────────────────────────────

  const quote = {
    ok: true,
    side: "UP",
    tokenId: "42",
    slug: "btc-updown-15m-1",
    price: 0.5,
    payout: 2,
    minOrderSize: 5,
    tickSize: 0.01,
    acceptingOrders: true,
  };
  const adapter = new PolymarketAdapter({
    apiKey: "k",
    apiSecret: "s",
    apiPassphrase: "p",
    walletAddress: "0xabc",
    privateKey: "0x01",
    client: {},
  });
  adapter.getQuote = async () => quote;

  const sized = await adapter._sizeFromSignal({ side: "UP", sizeUsd: "10.00", round: { openTs: 1 } });
  assert.strictEqual(sized.makerAmount, "10000000", "USD is sent in 6-decimal micro units");
  assert.strictEqual(sized.takerAmount, "20000000", "shares = usd / price");
  assert.strictEqual(sized.side, 0, "signal orders are BUY");
  assert.strictEqual(sized.quote.shares, 20);

  // $1 at 0.50 is 2 shares — below Polymarket's 5-share floor.
  await assert.rejects(
    () => adapter._sizeFromSignal({ side: "UP", sizeUsd: "1.00", round: { openTs: 1 } }),
    (err) => err.code === "below_min_size" && err.minSizeUsd === 2.5,
    "a lot under the venue minimum must be refused before signing"
  );

  // A closed round must never be traded.
  adapter.getQuote = async () => ({ ...quote, acceptingOrders: false });
  await assert.rejects(
    () => adapter._sizeFromSignal({ side: "UP", sizeUsd: "10.00", round: { openTs: 1 } }),
    (err) => err.code === "round_closed"
  );

  // Missing credentials still report auto_not_wired.
  const bare = new PolymarketAdapter({ client: {} });
  await assert.rejects(
    () => bare.marketBuy({ side: "UP", sizeUsd: "10.00" }),
    (err) => err.code === "auto_not_wired"
  );

  // ── timeframe guard ────────────────────────────────────────────────────────

  assert.ok(isSupportedTimeframe("5m") && isSupportedTimeframe("15m"));
  assert.ok(!isSupportedTimeframe("1m") && !isSupportedTimeframe("1h"));
  const unsupported = await resolveUpDown(
    { eventBySlug: async () => assert.fail("must not call the network for 1m") },
    { symbol: "BTCUSDT", timeframe: "1m", tsMs: Date.now() }
  );
  assert.strictEqual(unsupported.ok, false);
  assert.strictEqual(unsupported.reason, "timeframe_unsupported");

  // ── L1 auth, key derivation and proxy signing ──────────────────────────────

  const {
    signClobAuth,
    addressFromPrivateKey,
    signatureTypeFor,
    buildOrder,
    CLOB_AUTH_DOMAIN,
    CLOB_AUTH_TYPES,
    CLOB_AUTH_MESSAGE,
  } = require("./brokers/orderSigner");
  const { ethers } = require("ethers");

  const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const signerAddr = addressFromPrivateKey(TEST_PK);

  const auth = await signClobAuth(TEST_PK, { timestamp: 1790110800, nonce: 0 });
  assert.strictEqual(auth.address, signerAddr);
  assert.strictEqual(
    ethers.utils.verifyTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, {
      address: auth.address,
      timestamp: "1790110800",
      nonce: 0,
      message: CLOB_AUTH_MESSAGE,
    }, auth.signature),
    signerAddr,
    "the ClobAuth signature must recover to the signing key"
  );

  assert.strictEqual(signatureTypeFor("EOA"), 0);
  assert.strictEqual(signatureTypeFor("POLY_PROXY"), 1);
  assert.strictEqual(signatureTypeFor("POLY_GNOSIS_SAFE"), 2);

  // Wallet address == signer address means a plain EOA.
  const eoa = new PolymarketAdapter({ privateKey: TEST_PK, walletAddress: signerAddr, client: {} });
  assert.strictEqual(eoa.resolvedWalletType(), "EOA");

  // An email account funds from a proxy, so the addresses differ and the
  // order must be signed as POLY_PROXY or the CLOB rejects it.
  const proxyAddr = "0x1111111111111111111111111111111111111111";
  const proxy = new PolymarketAdapter({ privateKey: TEST_PK, walletAddress: proxyAddr, client: {} });
  assert.strictEqual(proxy.resolvedWalletType(), "POLY_PROXY");

  const proxyOrder = buildOrder({
    tokenId: "1",
    makerAmount: "1000000",
    takerAmount: "2000000",
    maker: proxyAddr,
    signer: signerAddr,
    signatureType: signatureTypeFor(proxy.resolvedWalletType()),
  });
  assert.strictEqual(proxyOrder.maker, proxyAddr, "funds come from the proxy wallet");
  assert.strictEqual(proxyOrder.signer, signerAddr, "the exported key signs");
  assert.strictEqual(proxyOrder.signatureType, 1);

  // Derivation stores the credentials on the adapter.
  let asked = null;
  const deriving = new PolymarketAdapter({
    privateKey: TEST_PK,
    walletAddress: proxyAddr,
    client: {
      deriveApiKey: async (payload) => {
        asked = payload;
        return { ok: true, apiKey: "A", secret: "B", passphrase: "C" };
      },
      configure: () => {},
    },
  });
  const derived = await deriving.deriveCredentials();
  assert.strictEqual(derived.ok, true);
  assert.strictEqual(deriving.apiKey, "A");
  assert.strictEqual(deriving.apiSecret, "B");
  assert.strictEqual(deriving.apiPassphrase, "C");
  assert.strictEqual(asked.address, signerAddr, "L1 auth is sent for the signer address");
  assert.ok(deriving.hasL2(), "a derived key pair completes L2");

  const noKey = new PolymarketAdapter({ client: {} });
  assert.strictEqual((await noKey.deriveCredentials()).reason, "missing_private_key");

  console.log("quote + payout tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
