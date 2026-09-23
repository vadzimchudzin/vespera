"use strict";

/**
 * One-button connect: key derivation, dependency skips, balance and
 * allowance checks, and the adapter's /balance-allowance parsing.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");
const { EXCHANGE_ADDRESS, NEG_RISK_EXCHANGE_ADDRESS, addressFromPrivateKey } = require("./brokers/orderSigner");

const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WALLET = "0x1111111111111111111111111111111111111111";
const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

function fakeClient({ online = true, derive = true, balance = "25000000", allowance = MAX, geo = null } = {}) {
  const calls = { derive: 0 };
  const client = {
    calls,
    apiKey: "",
    configure(p) {
      if (p.apiKey != null) this.apiKey = p.apiKey;
      return this;
    },
    async time() {
      return online ? { ok: true, status: 200, latencyMs: 42 } : { ok: false, status: 0, networkError: "ETIMEDOUT" };
    },
    async geoblock() {
      return geo || { ok: true, blocked: false };
    },
    async deriveApiKey() {
      calls.derive += 1;
      return derive ? { ok: true, apiKey: "K", secret: "S", passphrase: "P" } : { ok: false, status: 401, message: "Invalid L1 Request headers" };
    },
    async balanceAllowance() {
      return {
        ok: true,
        status: 200,
        json: { balance, allowances: { [EXCHANGE_ADDRESS.toLowerCase()]: allowance, [NEG_RISK_EXCHANGE_ADDRESS.toLowerCase()]: MAX } },
      };
    },
  };
  return client;
}

function engineWith(client, settings = {}) {
  const live = new PolymarketAdapter({ client, symbol: "BTCUSDT", timeframe: "15m" });
  live.getQuote = async () => ({ ok: true, side: "UP", slug: "btc-updown-15m-1", price: 0.5, payout: 2, minOrderSize: 5, feeRate: 0.07, feeExponent: 1 });
  return new Engine({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "vsp-connect-")),
    settings: { mode: "paper", baseUsd: "1.00", maxSteps: 6, ...settings },
    live,
    market: { bars: [], on() {}, start() {} },
  });
}

const status = (res) => Object.fromEntries(res.checks.map((c) => [c.id, c.status]));

(async () => {
  // ── adapter: balance + allowances ─────────────────────────────────────────
  {
    const a = new PolymarketAdapter({ client: fakeClient(), apiKey: "k", apiSecret: "s", apiPassphrase: "p", walletAddress: WALLET });
    const acct = await a.account();
    assert.deepStrictEqual(acct, { ok: true, balanceUsd: 25, exchange: "set", negRiskExchange: "set" });
    const zero = new PolymarketAdapter({ client: fakeClient({ allowance: "0" }), apiKey: "k", apiSecret: "s", apiPassphrase: "p", walletAddress: WALLET });
    assert.strictEqual((await zero.account()).exchange, "zero");
    assert.strictEqual((await new PolymarketAdapter({ client: fakeClient() }).account()).reason, "missing_l2");
  }

  // ── happy path: derive, all checks green, secrets handed back for storage ──
  {
    const client = fakeClient();
    const e = engineWith(client);
    const res = await e.connect({ walletAddress: WALLET, privateKey: TEST_PK, walletType: "AUTO" });
    assert.deepStrictEqual(status(res), {
      network: "ok",
      region: "ok",
      key: "ok",
      wallet: "ok",
      walletType: "ok",
      clobKeys: "ok",
      market: "ok",
      balance: "warn", // $25 covers the first bet but not a full ×2 series of six
      allowance: "ok",
    });
    assert.strictEqual(res.ready, true, "warnings do not block");
    assert.strictEqual(client.calls.derive, 1);
    assert.deepStrictEqual(res.credentials, { apiKey: "K", apiSecret: "S", apiPassphrase: "P" });
    const key = res.checks.find((c) => c.id === "key");
    assert.strictEqual(key.address, addressFromPrivateKey(TEST_PK));
    const bal = res.checks.find((c) => c.id === "balance");
    assert.strictEqual(bal.balance, 25);
    assert.strictEqual(bal.firstNeed, 2.59, "first bet is the 5-share minimum at 0.50 plus fee");
    assert.strictEqual(bal.baseBelowMin, true, "a $1 base is under the venue minimum");
    assert.ok(bal.seriesNeed > 25);
    assert.strictEqual(e.snapshot().lastConnect.ready, true, "last result is kept for the panel");
    assert.ok(!JSON.stringify(e.snapshot().lastConnect).includes('"S"'), "no secret in the snapshot");
  }

  // ── manual keys are used as typed, not re-derived ─────────────────────────
  {
    const client = fakeClient();
    const e = engineWith(client);
    const res = await e.connect({ walletAddress: WALLET, privateKey: TEST_PK, apiKey: "mine", apiSecret: "x", apiPassphrase: "y" });
    assert.strictEqual(client.calls.derive, 0);
    assert.strictEqual(res.checks.find((c) => c.id === "clobKeys").source, "manual");
    assert.strictEqual(res.credentials, null);
  }

  // ── offline / geoblocked: account checks are skipped, reason kept ─────────
  {
    const e = engineWith(fakeClient({ online: false, geo: { ok: true, blocked: true, country: "BY" } }));
    const res = await e.connect({ walletAddress: WALLET, privateKey: TEST_PK });
    const s = status(res);
    assert.strictEqual(s.network, "fail");
    assert.strictEqual(res.checks[0].blocked, true);
    assert.ok(res.checks[0].reason.includes("BY"));
    assert.strictEqual(s.key, "ok", "local checks still run");
    assert.strictEqual(s.clobKeys, "skip");
    assert.strictEqual(s.balance, "skip");
    assert.strictEqual(res.ready, false);
  }

  // ── reachable but geoblocked: reads still work, region fails, not ready ───
  {
    const e = engineWith(fakeClient({ geo: { ok: true, blocked: true, country: "BY" } }));
    const res = await e.connect({ walletAddress: WALLET, privateKey: TEST_PK });
    const s = status(res);
    assert.strictEqual(s.network, "ok", "/time answers from a blocked IP");
    assert.strictEqual(s.region, "fail");
    assert.strictEqual(res.checks.find((c) => c.id === "region").country, "BY");
    assert.strictEqual(s.balance, "warn", "balance is still read and shown");
    assert.strictEqual(res.ready, false, "orders would be refused, so not ready");
  }

  // ── missing key / bad wallet ───────────────────────────────────────────────
  {
    const e = engineWith(fakeClient());
    const res = await e.connect({ walletAddress: "0x123" });
    const s = status(res);
    assert.strictEqual(res.checks.find((c) => c.id === "key").reason, "missing");
    assert.strictEqual(res.checks.find((c) => c.id === "wallet").reason, "invalid");
    assert.strictEqual(s.walletType, "skip");
    assert.strictEqual(s.clobKeys, "skip");
  }

  // ── derive refused, empty wallet, no allowance, manual type mismatch ──────
  {
    let res = await engineWith(fakeClient({ derive: false })).connect({ walletAddress: WALLET, privateKey: TEST_PK });
    assert.strictEqual(status(res).clobKeys, "fail");
    assert.ok(res.checks.find((c) => c.id === "clobKeys").reason.includes("L1"));

    res = await engineWith(fakeClient({ balance: "1000000" })).connect({ walletAddress: WALLET, privateKey: TEST_PK });
    assert.strictEqual(status(res).balance, "fail", "$1 cannot pay the first bet");

    res = await engineWith(fakeClient({ allowance: "0" })).connect({ walletAddress: WALLET, privateKey: TEST_PK });
    assert.strictEqual(status(res).allowance, "fail");
    assert.strictEqual(res.ready, false);

    res = await engineWith(fakeClient()).connect({ walletAddress: WALLET, privateKey: TEST_PK, walletType: "POLY_GNOSIS_SAFE" });
    const wt = res.checks.find((c) => c.id === "walletType");
    assert.deepStrictEqual([wt.status, wt.used, wt.detected], ["warn", "POLY_GNOSIS_SAFE", "DEPOSIT_WALLET"]);
  }

  console.log("connect tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
