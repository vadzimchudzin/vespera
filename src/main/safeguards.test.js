"use strict";

/**
 * Auto safeguards: dry run, start confirmation, watchdog pause, order-error
 * pauses and the daily loss limit.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engine } = require("./engine");
const { PolymarketAdapter } = require("./brokers/polymarketAdapter");
const { todayPnl } = require("./stats");

const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vsp-guard-"));
}

function fakeMarket(bars = []) {
  return { bars, timer: null, on() {}, start() { this.timer = 1; }, stop() { this.timer = null; } };
}

function stubLive(extra = {}) {
  return {
    async ping() { return { ok: true }; },
    async getBalance() { return "100.00"; },
    hasPrivateKey() { return true; },
    configure() { return this; },
    ...extra,
  };
}

const bar = (openTs) => ({ openTs, closeTs: openTs + 899_999, open: 100, high: 101, low: 99, close: 100.5 });

(async () => {
  // ── dry run: signs, never posts, and returns the priced order ─────────────
  {
    let posted = 0;
    const venue = new PolymarketAdapter({
      privateKey: TEST_PK,
      walletAddress: "0x1111111111111111111111111111111111111111",
      client: { configure() {}, async postOrder() { posted += 1; return { ok: true, json: { success: true } }; } },
    });
    venue.getQuote = async () => ({ ok: true, side: "UP", tokenId: "7", slug: "s", price: 0.5, payout: 2, minOrderSize: 5, tickSize: 0.01, feeRate: 0.07, acceptingOrders: true, asks: [] });
    const order = await venue.marketBuy({ side: "UP", sizeUsd: "10.00", round: { openTs: 1 }, dryRun: true });
    assert.strictEqual(posted, 0, "dry run never posts");
    assert.strictEqual(order.dryRun, true);
    assert.ok(order.signature && order.signature.startsWith("0x"), "the order is really signed");
    assert.strictEqual(order.sizeUsd, "10.00");
    assert.strictEqual(order.feeUsd, "0.35000");
    assert.strictEqual(order.balanceChecked, false, "no L2 keys: balance not checked, and said so");
    await assert.rejects(
      () => new PolymarketAdapter({ client: {} }).marketBuy({ side: "UP", sizeUsd: "1", dryRun: true }),
      (err) => err.code === "auto_not_wired"
    );
  }

  // ── real-money Auto needs an explicit confirmation on start ────────────────
  {
    const e = new Engine({ userDataDir: dir(), settings: { mode: "auto", dryRun: false }, live: stubLive(), market: fakeMarket() });
    const refused = await e.start();
    assert.strictEqual(refused.reason, "live_confirm_required");
    assert.strictEqual(e.running, false);
    const ok = await e.start({ confirmLive: true });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(e.running, true);
    e.stop();

    const dry = new Engine({ userDataDir: dir(), settings: { mode: "auto" }, live: stubLive(), market: fakeMarket() });
    assert.strictEqual(dry.isDryRun(), true, "dry run is the default");
    assert.strictEqual((await dry.start()).ok, true, "dry run starts without confirmation");
    dry.stop();

    const paper = new Engine({ userDataDir: dir(), settings: { mode: "paper", dryRun: false }, live: stubLive(), market: fakeMarket() });
    assert.strictEqual((await paper.start()).ok, true, "paper never asks");
    paper.stop();

    // Turning dry run off while running stops Auto, so going live is always confirmed.
    const flip = new Engine({ userDataDir: dir(), settings: { mode: "auto" }, live: stubLive(), market: fakeMarket() });
    await flip.start();
    await flip.applySettings({ dryRun: false });
    assert.strictEqual(flip.running, false);
    assert.strictEqual((await flip.start()).reason, "live_confirm_required");
  }

  // ── geoblocked region: live Start refused, dry run allowed, 403 pauses ────
  {
    let blocked = true;
    const geoLive = () => stubLive({ async region() { return { ok: true, blocked, country: "BY" }; } });
    const e = new Engine({ userDataDir: dir(), settings: { mode: "auto", dryRun: false }, live: geoLive(), market: fakeMarket() });
    const refused = await e.start({ confirmLive: true });
    assert.deepStrictEqual([refused.ok, refused.reason, refused.country], [false, "geoblocked", "BY"]);
    assert.strictEqual(e.running, false);
    blocked = false;
    assert.strictEqual((await e.start({ confirmLive: true })).ok, true, "allowed region (or proxy) starts");
    e.stop();

    blocked = true;
    const dry = new Engine({ userDataDir: dir(), settings: { mode: "auto" }, live: geoLive(), market: fakeMarket() });
    assert.strictEqual((await dry.start()).ok, true, "dry run never posts, so it may run anywhere");
    dry.stop();

    const unknown = new Engine({
      userDataDir: dir(),
      settings: { mode: "auto", dryRun: false },
      live: stubLive({ async region() { return { ok: false, reason: "timeout" }; } }),
      market: fakeMarket(),
    });
    assert.strictEqual((await unknown.start({ confirmLive: true })).ok, true, "an unknown region does not block");
    unknown._onOrderError({ code: "geoblocked" }, "geoblocked: Trading restricted in your region");
    assert.strictEqual(unknown.status, "paused", "a region refusal pauses at once");
    assert.ok(unknown.pauseReason.startsWith("geoblocked"));
  }

  // ── broken proxy: live Start refused with the reason, bad login pauses ────
  {
    let health = { ok: false, code: "proxy_target_refused", reason: "Socks5 proxy rejected connection - ConnectionRefused" };
    const live = stubLive({
      async health() { return health; },
      async region() { return { ok: true, blocked: false, country: "LT" }; },
    });
    const e = new Engine({ userDataDir: dir(), settings: { mode: "auto", dryRun: false }, live, market: fakeMarket() });
    const refused = await e.start({ confirmLive: true });
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "proxy_target_refused"]);
    assert.ok(/ConnectionRefused/.test(refused.detail));
    health = { ok: false, code: "timeout", reason: "timeout" };
    assert.strictEqual((await e.start({ confirmLive: true })).ok, true, "a transient failure does not block Start");
    e._onOrderError({ code: "clob_order_rejected", networkCode: "proxy_auth", response: { status: 0 } }, "Socks5 Authentication failed");
    assert.strictEqual(e.status, "paused", "a proxy login failure pauses at once");
    assert.ok(e.pauseReason.startsWith("proxy_auth"));
  }

  // ── test bet: priced first, placed only on confirm, series untouched ──────
  {
    const bought = [];
    const live = stubLive({
      slippage: 0.02,
      async getQuote({ side }) { return { ok: true, side, price: 0.54, tickSize: 0.01, minOrderSize: 5, slug: "btc-updown-15m-1" }; },
      async marketBuy(p) {
        bought.push(p);
        return { sizeUsd: p.sizeUsd, price: 0.54, shares: 5.2, orderId: "0x1", orderStatus: "matched", slug: "btc-updown-15m-1" };
      },
    });
    const paper = new Engine({ userDataDir: dir(), settings: { mode: "paper" }, live, market: fakeMarket() });
    assert.strictEqual((await paper.testOrder({ side: "UP" })).reason, "test_auto_only");

    const e = new Engine({ userDataDir: dir(), settings: { mode: "auto", dryRun: false }, live, market: fakeMarket() });
    const step = e.risk.step;
    const plan = await e.testOrder({ side: "DOWN" });
    assert.deepStrictEqual([plan.ok, plan.reason, plan.side, plan.dryRun], [false, "test_confirm", "DOWN", false]);
    assert.strictEqual(plan.sizeUsd, "2.81", "5 shares at the 0.56 ceiling, plus a cent");
    assert.strictEqual(bought.length, 0, "nothing is sent without confirm");
    const done = await e.testOrder({ side: "DOWN", confirm: true });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(bought.length, 1);
    assert.strictEqual(bought[0].dryRun, false);
    assert.strictEqual(e.liveBet, null, "not tracked as a strategy bet");
    assert.strictEqual(e.risk.step, step, "series untouched");
    assert.ok(e.journal.entries.some((r) => r.type === "test_order" && r.side === "DOWN"));

    assert.strictEqual((await e.testOrder({ side: "UP", confirm: true })).reason, "test_open_bet", "test position locks the round");
    e.lastTestOrder.roundCloseTs = Date.now() - 1;

    live.marketBuy = async () => { const err = new Error("clob_order_rejected: 400 x"); err.code = "clob_order_rejected"; throw err; };
    const failed = await e.testOrder({ side: "UP", confirm: true });
    assert.deepStrictEqual([failed.ok, failed.reason], [false, "clob_order_rejected"]);
    assert.notStrictEqual(e.status, "paused", "a failed test bet never pauses Auto");
  }

  // ── adapter: 403 region refusal becomes a geoblocked error ────────────────
  {
    const venue = new PolymarketAdapter({
      privateKey: TEST_PK,
      walletAddress: "0x1111111111111111111111111111111111111111",
      apiKey: "k",
      apiSecret: "cw==",
      apiPassphrase: "p",
      walletType: "EOA",
      client: {
        configure() {},
        async balanceAllowance() { return { ok: true, json: { balance: "100000000" } }; },
        async postOrder() {
          return { ok: false, status: 403, json: { error: "Trading restricted in your region, please refer to available regions" } };
        },
      },
    });
    venue.getQuote = async () => ({ ok: true, side: "UP", tokenId: "7", slug: "s", price: 0.5, payout: 2, minOrderSize: 5, tickSize: 0.01, feeRate: 0.07, acceptingOrders: true, asks: [] });
    await assert.rejects(
      () => venue.marketBuy({ side: "UP", sizeUsd: "5.00", round: { openTs: 1 } }),
      (err) => err.code === "geoblocked" && /restricted in your region/.test(err.message)
    );
  }

  // ── watchdog: three failed health checks pause Auto ─────────────────────────
  {
    let healthy = false;
    const e = new Engine({
      userDataDir: dir(),
      settings: { mode: "auto" },
      live: stubLive({ async health() { return healthy ? { ok: true } : { ok: false, reason: "geoblocked BY" }; } }),
      market: fakeMarket(),
    });
    await e.start();
    await e._healthTick();
    await e._healthTick();
    assert.strictEqual(e.running, true, "two blips are tolerated");
    healthy = true;
    await e._healthTick();
    assert.strictEqual(e.venueFailures, 0, "a good check resets the count");
    healthy = false;
    for (let i = 0; i < 3; i += 1) await e._healthTick();
    assert.strictEqual(e.running, false);
    assert.strictEqual(e.status, "paused");
    assert.ok(e.pauseReason.includes("geoblocked BY"), e.pauseReason);
    assert.ok(e.journal.entries.some((x) => x.type === "auto_paused"));
    await e.start();
    assert.strictEqual(e.pauseReason, null, "Start resumes and clears the reason");
    e.stop();
  }

  // ── order errors: permanent ones pause at once, rejections after two ───────
  {
    const mk = () => new Engine({ userDataDir: dir(), settings: { mode: "auto" }, live: stubLive(), market: fakeMarket() });
    let e = mk();
    await e.start();
    e._onOrderError({ code: "insufficient_balance" }, "insufficient_balance: $1 < $10");
    assert.strictEqual(e.status, "paused", "no money: pause immediately");

    e = mk();
    await e.start();
    e._onOrderError({ code: "clob_order_rejected", response: { status: 400 } }, "invalid signature");
    assert.strictEqual(e.running, true);
    e._onOrderError({ code: "clob_order_rejected", response: { status: 400 } }, "invalid signature");
    assert.strictEqual(e.status, "paused", "two rejections in a row pause");

    e = mk();
    await e.start();
    e._onOrderError({ code: "round_closed" }, "round_closed");
    assert.strictEqual(e.running, true, "a closed round is not a reason to stop");
    e._onOrderError({ code: "clob_order_rejected", response: { status: 0 } }, "network: timeout");
    assert.strictEqual(e.venueFailures, 1, "network errors count toward the watchdog");
    e.stop();
  }

  // ── no quote at signal time is reported and counted, not silently skipped ──
  {
    const bars = Array.from({ length: 230 }, (_, i) => bar(i * 900_000));
    const e = new Engine({
      userDataDir: dir(),
      settings: { mode: "auto" },
      live: stubLive({ async getQuote() { return { ok: false, reason: "network: ETIMEDOUT" }; } }),
      market: fakeMarket(bars),
    });
    await e.start();
    const notes = [];
    e.on((evt) => { if (evt.type === "notify") notes.push(evt.payload.title); });
    await e._openFromSignal({ signal: "UP", reason: "test" }, bars[228]);
    assert.ok(e.journal.entries.some((x) => x.type === "skip" && x.reason === "venue_unavailable"));
    assert.ok(notes.includes("Round skipped"), "the skip is notified");
    assert.strictEqual(e.venueFailures, 1);
    assert.strictEqual(e.liveBet, null);
    e.stop();
  }

  // ── dry-run bets run the whole live path and keep their own book ──────────
  {
    const bars = Array.from({ length: 230 }, (_, i) => bar(i * 900_000));
    const e = new Engine({
      userDataDir: dir(),
      settings: { mode: "auto", baseUsd: "5.00" },
      live: stubLive({
        async getQuote() { return { ok: true, side: "UP", price: 0.5, payout: 2, feeRate: 0.07, minOrderSize: 5 }; },
        async marketBuy(p) {
          assert.strictEqual(p.dryRun, true, "engine asks for a dry run");
          return { ok: true, dryRun: true, sizeUsd: "5.00", shares: 10, price: 0.5, payout: 2, feeUsd: "0.18", slug: "s" };
        },
      }),
      market: fakeMarket(bars),
    });
    await e.start();
    await e._openFromSignal({ signal: "UP", reason: "test" }, bars[228]);
    assert.ok(e.liveBet && e.liveBet.dryRun, "dry-run bet is tracked like a live one");
    const settled = e._settleLive({ close: 90, closeTs: e.liveBet.roundCloseTs });
    assert.strictEqual(settled.dryRun, true);
    assert.strictEqual(settled.pnl, "-5.18");
    assert.strictEqual(e.snapshot().book, "dry");
    assert.strictEqual(e.snapshot().stats.count, 1, "dry-run stats count the dry bet");
    assert.strictEqual(todayPnl(e.journal.entries, "live"), 0, "and the live book stays empty");
    e.stop();
  }

  // ── daily loss limit ──────────────────────────────────────────────────────
  {
    const d = dir();
    const e = new Engine({ userDataDir: d, settings: { mode: "paper", dailyLossLimitUsd: 5 }, live: stubLive(), market: fakeMarket(Array.from({ length: 230 }, (_, i) => bar(i * 900_000))) });
    e.journal.write({ type: "settled", status: "loss", pnl: "-3.10" });
    assert.strictEqual(e.todayPnl(), -3.1);
    assert.strictEqual((await e.start()).ok, true);
    e.journal.write({ type: "settled", status: "loss", pnl: "-2.07" });
    await e.onBarClose(bar(231 * 900_000));
    assert.strictEqual(e.running, false, "stops once today's loss reaches the limit");
    assert.strictEqual(e.status, "daily_limit");
    assert.strictEqual((await e.start()).reason, "daily_limit", "and refuses to start again today");
    assert.strictEqual(e.journal.entries.at(-1).type, "start_refused", "the refusal remains visible in the activity log");
    assert.strictEqual(e.journal.entries.at(-1).reason, "daily_limit");
    // yesterday's losses do not count
    const old = new Date(Date.now() - 36 * 3600_000).toISOString();
    assert.strictEqual(todayPnl([{ ts: old, type: "settled", pnl: "-50" }], "paper"), 0);
    await e.applySettings({ dailyLossLimitUsd: 0 });
    assert.strictEqual((await e.start()).ok, true, "limit 0 = off");
    e.stop();
  }

  console.log("safeguard tests ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
