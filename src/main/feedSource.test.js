"use strict";

/**
 * Candle source: Binance.com first, the official market-data mirror second, Binance.US only as a flagged
 * last resort. A degraded feed refuses real-money Start and never places a real order.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { MarketData, KLINE_HOSTS, WS_HOSTS } = require("./marketData");
const { Engine } = require("./engine");
const { INTERVAL_MS } = require("./markets");

const interval = INTERVAL_MS["15m"];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vsp-feed-"));

function rows(count, end = Math.floor(Date.now() / interval) * interval) {
  const out = [];
  for (let i = count; i >= 1; i -= 1) {
    const openTs = end - i * interval;
    const close = 100 + (i % 7);
    out.push([openTs, String(close), String(close + 1), String(close - 1), String(close), "1", openTs + interval - 1]);
  }
  return out;
}

class FakeWebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 0; }
  close() {}
  terminate() {}
  ping() {}
  pong() {}
}

function marketWith(blockedPrefixes) {
  const seen = [];
  const fetchJson = async (url) => {
    seen.push(url);
    if (blockedPrefixes.some((prefix) => url.startsWith(prefix))) throw new Error("HTTP 451");
    return rows(300);
  };
  return { md: new MarketData({ fetchJson, webSocketImpl: FakeWebSocket }), seen };
}

const COM = "https://api.binance.com";
const MIRROR = "https://data-api.binance.vision";
const US = "https://api.binance.us";

function fakeMarket(feed) {
  return {
    bars: [],
    on() {},
    start() {},
    stop() {},
    ...(feed ? { feedStatus: () => feed } : {}),
  };
}
function stubLive(extra = {}) {
  return { async ping() { return { ok: true }; }, async getBalance() { return "100.00"; }, hasPrivateKey() { return true; }, configure() { return this; }, ...extra };
}
const DEGRADED = { rest: US, ws: null, degraded: true, reason: "binance_us_fallback" };
const HEALTHY = { rest: COM, ws: "wss://data-stream.binance.vision", degraded: false, reason: null };

(async () => {
  // ── host order is part of the contract ────────────────────────────────────
  assert.deepStrictEqual(KLINE_HOSTS, [COM, MIRROR, US], "Binance.com, then its mirror, Binance.US strictly last");

  // ── REST history: which host served it ────────────────────────────────────
  {
    const { md, seen } = marketWith([]);
    await md.loadHistory(300, { emitHistory: false });
    assert.strictEqual(md.feedStatus().rest, COM);
    assert.strictEqual(md.feedStatus().degraded, false);
    assert.ok(seen[0].startsWith(COM), "Binance.com is asked first");
    md.stop();
  }
  {
    const { md, seen } = marketWith([COM]);
    await md.loadHistory(300, { emitHistory: false });
    assert.strictEqual(md.feedStatus().rest, MIRROR, "api.binance.com answers 451: the Binance.com mirror serves the history");
    assert.strictEqual(md.feedStatus().degraded, false, "mirror data is Binance.com data, not a degraded feed");
    assert.ok(seen[0].startsWith(COM) && seen[1].startsWith(MIRROR) && !seen.some((u) => u.startsWith(US)), "Binance.US is never touched while the mirror works");
    md.stop();
  }
  {
    const { md } = marketWith([COM, MIRROR]);
    await md.loadHistory(300, { emitHistory: false });
    const status = md.feedStatus();
    assert.strictEqual(status.rest, US);
    assert.strictEqual(status.degraded, true, "only Binance.US left: flagged");
    assert.strictEqual(status.reason, "binance_us_fallback");
    md.stop();
  }
  {
    const { md } = marketWith([COM, MIRROR, US]);
    await assert.rejects(md.loadHistory(300, { emitHistory: false }), /HTTP 451/);
    assert.deepStrictEqual(md.feedStatus(), { rest: null, ws: null, degraded: false, reason: null }, "no data, nothing claimed");
    md.stop();
  }

  // ── WebSocket host is tracked once it delivers ────────────────────────────
  {
    const md = new MarketData({ fetchJson: async () => rows(300), webSocketImpl: FakeWebSocket });
    md._wanted = true;
    md._wsIndex = WS_HOSTS.findIndex((host) => /binance\.us/.test(host));
    assert.ok(md._wsIndex >= 0, "the list contains a Binance.US stream");
    md._openWs();
    assert.strictEqual(md.feedStatus().ws, null, "connecting is not delivering");
    md.ws.emit("open");
    assert.ok(/binance\.us/.test(md.feedStatus().ws));
    assert.strictEqual(md.feedStatus().degraded, true, "a Binance.US stream degrades the feed");
    md._wsIndex = 0;
    md._openWs();
    md.ws.emit("open");
    assert.strictEqual(md.feedStatus().ws, WS_HOSTS[0]);
    assert.strictEqual(md.feedStatus().degraded, false, "back on the Binance.com stream");
    md._wanted = false;
    md.stop();
  }

  // ── engine: real money is refused on a degraded feed ──────────────────────
  {
    const e = new Engine({ userDataDir: tmp(), settings: { mode: "auto", dryRun: false }, live: stubLive(), market: fakeMarket(DEGRADED) });
    const refused = await e.start({ confirmLive: true });
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "feed_source_not_binance_com"]);
    assert.strictEqual(e.running, false);
    assert.strictEqual(e.status, "paused");
    assert.ok(/feed_source_not_binance_com/.test(e.pauseReason));
    assert.ok(e.journal.entries.some((row) => row.type === "start_refused" && row.reason === "feed_source_not_binance_com"));
    assert.ok(e.journal.entries.some((row) => row.type === "data_health" && row.event === "feed_fallback_binance_us"));
    assert.strictEqual(e.snapshot().feed.degraded, true, "the status carries the feed source");
  }
  {
    // a feed that degrades while real money is running never produces an order
    const e = new Engine({ userDataDir: tmp(), settings: { mode: "auto", dryRun: false }, live: stubLive({ async marketBuy() { throw new Error("must not place an order"); } }), market: fakeMarket(HEALTHY) });
    assert.strictEqual((await e.start({ confirmLive: true })).ok, true, "healthy feed starts");
    e.market.feedStatus = () => DEGRADED;
    const out = await e._executeSignal({ signal: "UP", reason: "long" }, { openTs: 0, closeTs: interval - 1, open: 100, high: 101, low: 99, close: 100.5 });
    assert.strictEqual(out, null);
    assert.strictEqual(e.running, false, "paused");
    assert.ok(/feed_source_not_binance_com/.test(e.pauseReason));
    assert.ok(e.journal.entries.some((row) => row.type === "skip" && row.reason === "feed_source_not_binance_com" && row.signal === "UP"));
    assert.ok(!e.journal.entries.some((row) => row.type === "order_sent"));
  }

  // ── Paper and dry run keep running, with a warning ────────────────────────
  for (const settings of [{ mode: "paper" }, { mode: "auto" }]) {
    const e = new Engine({ userDataDir: tmp(), settings, live: stubLive(), market: fakeMarket(DEGRADED) });
    assert.strictEqual((await e.start()).ok, true, `${settings.mode} (dry run) is allowed on a degraded feed`);
    assert.strictEqual(e.running, true);
    assert.ok(e.journal.entries.some((row) => row.type === "data_health" && row.event === "feed_fallback_binance_us"), "and says so");
    e.stop();
  }

  // ── a market without feed information changes nothing ─────────────────────
  {
    const e = new Engine({ userDataDir: tmp(), settings: { mode: "auto", dryRun: false }, live: stubLive(), market: fakeMarket(null) });
    assert.strictEqual(e.snapshot().feed, null);
    assert.strictEqual((await e.start({ confirmLive: true })).ok, true);
    e.stop();
  }

  console.log("feed source tests ok");
})().catch((err) => { console.error(err); process.exitCode = 1; });
