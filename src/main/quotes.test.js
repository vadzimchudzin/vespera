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
  const broker = new PaperBroker({ startingBalance: "100.00", feeRate: 0, takerFeeRate: 0 });
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

  // Polymarket resolves "Up" when the end price is >= the start price.
  const flat = await payoutCase({
    payout: 1 / 0.7,
    side: "UP",
    settleClose: 100,
    expectPnl: "4.29",
    label: "flat is UP",
  });
  assert.strictEqual(flat.outcome, "UP");
  await payoutCase({
    payout: 1 / 0.7,
    side: "DOWN",
    settleClose: 100,
    expectPnl: "-10.00",
    label: "flat loses DOWN",
  });

  // Paper charges the crypto taker fee: stake × 0.07 × (1 − p). $10 at 0.50 → $0.35.
  {
    const feeBroker = new PaperBroker({ startingBalance: "100.00" });
    const placed = await feeBroker.marketBuy({
      side: "UP",
      sizeUsd: "10.00",
      clientOrderId: "fee",
      round: { strike: 100, openTs: 1, closeTs: 2 },
      payout: 2,
      price: 0.5,
    });
    assert.strictEqual(placed.feeUsd, "0.35");
    assert.strictEqual(placed.feeModel, "polymarket_taker");
    const lost = feeBroker.settle({ close: 99, closeTs: 2 });
    assert.strictEqual(lost.pnl, "-10.35");
  }

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

  // Thin best ask: the FOK limit sweeps up to the level that covers the stake,
  // and amounts respect the 0.001 tick precision.
  adapter.getQuote = async () => ({
    ...quote,
    price: 0.512,
    tickSize: 0.001,
    feeRate: 0.07,
    asks: [
      { price: "0.530", size: "100" },
      { price: "0.512", size: "5" },
    ],
  });
  const swept = await adapter._sizeFromSignal({ side: "UP", sizeUsd: "10.00", round: { openTs: 1 } });
  assert.strictEqual(swept.quote.price, 0.53, "limit covers the whole stake");
  assert.strictEqual(swept.takerAmount, "18860000", "shares rounded down to 2 decimals");
  assert.strictEqual(swept.makerAmount, "9995800", "USD = shares × price");
  assert.ok(Number(swept.quote.feeUsd) > 0, "fee is estimated");

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

  // A legacy email account funds from its CREATE2 proxy, so the order must be
  // POLY_PROXY; a Safe is POLY_GNOSIS_SAFE; any other address is a Deposit Wallet.
  const { proxyWalletAddress, safeWalletAddress } = require("./brokers/orderSigner");
  const proxyAddr = proxyWalletAddress(signerAddr);
  const proxy = new PolymarketAdapter({ privateKey: TEST_PK, walletAddress: proxyAddr, client: {} });
  assert.strictEqual(proxy.resolvedWalletType(), "POLY_PROXY");
  const safe = new PolymarketAdapter({ privateKey: TEST_PK, walletAddress: safeWalletAddress(signerAddr), client: {} });
  assert.strictEqual(safe.resolvedWalletType(), "POLY_GNOSIS_SAFE");
  const depositAddr = "0x1111111111111111111111111111111111111111";
  const deposit = new PolymarketAdapter({ privateKey: TEST_PK, walletAddress: depositAddr, client: {} });
  assert.strictEqual(deposit.resolvedWalletType(), "DEPOSIT_WALLET");
  assert.strictEqual(signatureTypeFor("DEPOSIT_WALLET"), 3);
  const forced = new PolymarketAdapter({ privateKey: TEST_PK, walletAddress: depositAddr, walletType: "POLY_PROXY", client: {} });
  assert.strictEqual(forced.resolvedWalletType(), "POLY_PROXY", "an explicit type wins over detection");

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

  // ── CLOB V2 order signing ───────────────────────────────────────────────────
  {
    const {
      signOrder,
      exchangeDomain,
      ORDER_TYPES,
      TYPED_DATA_SIGN_TYPES,
      ORDER_TYPE_STRING,
      ZERO_BYTES32,
    } = require("./brokers/orderSigner");
    const order = buildOrder({
      tokenId: "123",
      makerAmount: "5200000",
      takerAmount: "10000000",
      maker: proxyAddr,
      signer: signerAddr,
      signatureType: 1,
      timestamp: 1790110800000,
    });
    for (const gone of ["nonce", "feeRateBps", "taker", "expiration"]) {
      assert.ok(!(gone in order), `V2 order has no ${gone}`);
    }
    assert.strictEqual(order.timestamp, "1790110800000");
    assert.strictEqual(order.metadata, ZERO_BYTES32);
    assert.ok(Number(order.salt) <= Number.MAX_SAFE_INTEGER);

    const signed = await signOrder(order, TEST_PK);
    const domain = exchangeDomain(false);
    assert.strictEqual(domain.version, "2");
    assert.strictEqual(domain.verifyingContract, "0xE111180000d2663C0091e4f400237545B87B996B");
    const { salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder } = order;
    const msg = { salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder };
    assert.strictEqual(ethers.utils.verifyTypedData(domain, ORDER_TYPES, msg, signed.signature), signerAddr);
    assert.strictEqual(
      ethers.utils._TypedDataEncoder.from(ORDER_TYPES).encodeType("Order"),
      ORDER_TYPE_STRING,
      "EIP-712 type string matches the V2 Order struct"
    );
    const negRisk = await signOrder(order, TEST_PK, { negRisk: true });
    assert.notStrictEqual(negRisk.signature, signed.signature, "neg-risk markets sign against their own exchange");

    // Deposit Wallet: ERC-7739 wrapped signature.
    const dwOrder = { ...order, maker: depositAddr, signer: depositAddr, signatureType: 3 };
    const dw = await signOrder(dwOrder, TEST_PK);
    const bytes = ethers.utils.arrayify(dw.signature);
    const typeLen = ORDER_TYPE_STRING.length;
    assert.strictEqual(bytes.length, 65 + 32 + 32 + typeLen + 2, "inner sig + separator + hash + type + length");
    assert.strictEqual((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1], typeLen);
    const inner = ethers.utils.hexlify(bytes.slice(0, 65));
    const dwMsg = { ...msg, maker: depositAddr, signer: depositAddr, signatureType: 3 };
    const recovered = ethers.utils.verifyTypedData(domain, TYPED_DATA_SIGN_TYPES, {
      contents: dwMsg,
      name: "DepositWallet",
      version: "1",
      chainId: 137,
      verifyingContract: depositAddr,
      salt: ZERO_BYTES32,
    }, inner);
    assert.strictEqual(recovered, signerAddr, "inner TypedDataSign is signed by the account key");
    assert.strictEqual(
      ethers.utils.hexlify(bytes.slice(65, 97)),
      ethers.utils._TypedDataEncoder.hashDomain(domain)
    );
    assert.strictEqual(
      ethers.utils.hexlify(bytes.slice(97, 129)),
      ethers.utils._TypedDataEncoder.hashStruct("Order", ORDER_TYPES, dwMsg)
    );

    // Wire body + auth headers.
    const { ClobClient: Clob } = require("./brokers/clobClient");
    let sent = null;
    const wire = new Clob({
      apiKey: "key",
      apiSecret: Buffer.from("secret").toString("base64"),
      apiPassphrase: "pass",
      walletAddress: proxyAddr,
      signerAddress: signerAddr,
      signatureType: 1,
      request: async (url, opts) => {
        sent = { url, ...opts };
        return { ok: true, status: 200, json: { success: false, errorMsg: "not enough balance / allowance" } };
      },
    });
    const posted = await wire.postOrder(signed);
    assert.strictEqual(posted.ok, false, "success:false is a rejection even on HTTP 200");
    assert.strictEqual(posted.raw, "not enough balance / allowance");
    assert.strictEqual(sent.headers.POLY_ADDRESS, signerAddr, "L2 auth identifies the signer, not the funder");
    assert.strictEqual(sent.body.owner, "key");
    assert.strictEqual(sent.body.order.side, "BUY");
    assert.strictEqual(typeof sent.body.order.salt, "number");
    assert.strictEqual(sent.body.order.signature, signed.signature);
    assert.strictEqual(sent.body.order.timestamp, "1790110800000");
    assert.ok(!("feeRateBps" in sent.body.order) && !("nonce" in sent.body.order));

    await wire.balanceAllowance();
    assert.ok(sent.url.endsWith("/balance-allowance?asset_type=COLLATERAL&signature_type=1"), sent.url);
  }

  // Resolution is read from Gamma once the market closes.
  {
    const resolver = new PolymarketAdapter({
      client: {
        eventBySlug: async () => ({
          ok: true,
          status: 200,
          json: { markets: [{ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }] },
        }),
      },
    });
    assert.deepStrictEqual(await resolver.resolvedOutcome("btc-updown-15m-1"), { resolved: true, outcome: "DOWN" });
    const open = new PolymarketAdapter({
      client: { eventBySlug: async () => ({ ok: true, status: 200, json: { markets: [{ closed: false }] } }) },
    });
    assert.deepStrictEqual(await open.resolvedOutcome("x"), { resolved: false });
  }

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

  // ── failures must be reportable, never a hang ─────────────────────────────

  const { requestJson, ClobClient, setProxy, currentProxy } = require("./brokers/clobClient");

  // An unreachable host has to resolve with a reason instead of rejecting —
  // a rejection left the API panel stuck on "signing and asking the CLOB".
  const dead = await requestJson("https://127.0.0.1:1/time", { timeoutMs: 1500 });
  assert.strictEqual(dead.ok, false);
  assert.strictEqual(dead.status, 0);
  assert.ok(dead.networkError, "a network failure is reported, not thrown");

  // A blocked region is a different failure from an unreachable host.
  const blockedClient = new ClobClient({
    request: async (url) =>
      url.includes("/api/geoblock")
        ? { ok: true, status: 200, json: { blocked: true, country: "BY", region: "HM" } }
        : { ok: false, status: 0, json: null, raw: "timeout", networkError: "timeout" },
  });
  const geo = await blockedClient.geoblock();
  assert.deepStrictEqual(
    { ok: geo.ok, blocked: geo.blocked, country: geo.country },
    { ok: true, blocked: true, country: "BY" }
  );

  const blockedVenue = new PolymarketAdapter({ client: blockedClient });
  const blockedPing = await blockedVenue.ping();
  assert.strictEqual(blockedPing.ok, false);
  assert.strictEqual(blockedPing.blocked, true, "ping says the region is blocked");
  assert.ok(blockedPing.message.startsWith("network:"), "and still reports the transport error");

  // Derivation surfaces the reason rather than hanging.
  const blockedDerive = new PolymarketAdapter({ privateKey: TEST_PK, client: blockedClient });
  const failed = await blockedDerive.deriveCredentials();
  assert.strictEqual(failed.ok, false);
  assert.ok(failed.reason, "a failed derive always carries a reason");

  // Proxy toggling is idempotent and clearable.
  setProxy("");
  assert.strictEqual(currentProxy().active, false);
  setProxy("http://127.0.0.1:9");
  assert.strictEqual(currentProxy().url, "http://127.0.0.1:9");
  setProxy("");
  assert.strictEqual(currentProxy().active, false, "clearing the proxy restores direct calls");

  // The agent ships as a runtime dependency, so a proxy URL actually routes.
  setProxy("http://127.0.0.1:9");
  assert.strictEqual(currentProxy().active, true, "https-proxy-agent must load");
  setProxy("");

  console.log("quote + payout tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
