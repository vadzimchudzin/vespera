"use strict";

const assert = require("node:assert/strict");
const { updownSlug, resolveUpDown, getSupportedTimeframes, isSupportedMarket, fitToPolymarket } = require("./polymarketMarkets");

function fixture(symbol, timeframe, time) {
  const openTs = Math.floor(time / (timeframe === "1h" ? 3600000 : 14400000)) * (timeframe === "1h" ? 3600000 : 14400000);
  const asset = symbol.replace("USDT", "").toLowerCase();
  const slug = updownSlug(symbol, timeframe, time);
  return { slug, markets: [{ slug, active: true, closed: false, acceptingOrders: true,
    eventStartTime: new Date(openTs).toISOString(), endDate: new Date(openTs + (timeframe === "1h" ? 3600000 : 14400000)).toISOString(),
    outcomes: '["Up","Down"]', clobTokenIds: '["111","222"]',
    resolutionSource: timeframe === "1h" ? `https://www.binance.com/en/trade/${symbol.replace("USDT", "_USDT")}` : `https://data.chain.link/streams/${asset}-usd-twap-60s-streams`,
    description: "Up if the price is greater than or equal to the start; otherwise Down.",
  }] };
}

async function run() {
  const time = Date.parse("2026-10-07T04:30:00Z");
  assert.equal(updownSlug("BTCUSDT", "1h", time), "bitcoin-up-or-down-october-7-2026-12am-et");
  assert.equal(updownSlug("ETHUSDT", "1h", Date.parse("2026-01-01T05:15:00Z")), "ethereum-up-or-down-january-1-2026-12am-et");
  assert.equal(updownSlug("SOLUSDT", "1h", Date.parse("2026-07-01T16:15:00Z")), "solana-up-or-down-july-1-2026-12pm-et");
  assert.equal(updownSlug("BTCUSDT", "4h", Date.parse("2026-10-07T03:30:00Z")), "btc-updown-4h-1791331200");
  assert.deepEqual(getSupportedTimeframes("DOGEUSDT"), ["5m", "15m"]);
  assert.equal(isSupportedMarket("DOGEUSDT", "1h"), false);
  assert.equal(updownSlug("DOGEUSDT", "4h", time), null, "unsupported mappings do not silently fall back");
  assert.deepEqual(fitToPolymarket("DOGEUSDT", "1h"), { symbol: "DOGEUSDT", timeframe: "15m" });
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]) for (const timeframe of ["1h", "4h"]) {
    const event = fixture(symbol, timeframe, time);
    const client = { async eventBySlug(slug) { assert.equal(slug, event.slug); return { ok: true, json: event }; } };
    const result = await resolveUpDown(client, { symbol, timeframe, tsMs: time });
    assert.equal(result.ok, true);
    for (const patch of [
      { eventStartTime: "2026-10-07T00:00:00Z" }, { endDate: "2026-10-08T00:00:00Z" },
      { clobTokenIds: '["111","111"]' }, { outcomes: '["Yes","No"]' },
      { slug: "wrong" }, { resolutionSource: "https://example.invalid" },
      { description: "a different rule" },
    ]) {
      const modified = { ...event, markets: [{ ...event.markets[0], ...patch }] };
      const checked = await resolveUpDown({ eventBySlug: async () => ({ ok: true, json: modified }) }, { symbol, timeframe, tsMs: time });
      assert.equal(checked.ok, false, `${symbol}/${timeframe} rejects mismatched market contract`);
      assert.equal(checked.reason, "market_contract_mismatch");
    }
  }
  const dstTime = Date.parse("2026-11-01T06:30:00Z");
  const firstHour = fixture("BTCUSDT", "1h", Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(updownSlug("BTCUSDT", "1h", dstTime), firstHour.slug, "ET fall-back labels are ambiguous");
  const dst = await resolveUpDown({ eventBySlug: async () => ({ ok: true, json: firstHour }) }, { symbol: "BTCUSDT", timeframe: "1h", tsMs: dstTime });
  assert.equal(dst.reason, "market_contract_mismatch", "ambiguous ET label cannot trade the wrong UTC hour");
  await resolveUpDown({ eventBySlug: async () => assert.fail("unsupported pair must not make a request") }, { symbol: "BNBUSDT", timeframe: "4h", tsMs: time });
  console.log("Verified 1h/4h market mapping tests ok");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
