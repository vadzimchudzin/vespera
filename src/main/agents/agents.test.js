"use strict";

// The agents desk, pure parts: the pricing models, Polymarket data, the paper book, sizing and limits, the
// scanners, the roster rules, the language-model replies and the report texts. No network, no clock.

const assert = require("assert");
const M = require("./models");
const MK = require("./market");
const { PaperBook, freshBook, walkCost, simulateBuy } = require("./paper");
const { kellyStake, capacity, haltCheck, MAX_PER_MATCH, matchCount } = require("./risk");
const SC = require("./scanners");
const R = require("./roster");
const B = require("./brain");
const T = require("./report");
const { validateConfig, validateState, initialState, DEFAULT_CONFIG } = require("./state");
const { Sources, newsQuery, decodeXml } = require("./sources");

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const cid = (id) => `0x${Buffer.from(String(id)).toString("hex").padStart(64, "0")}`;
const say = (ru, en) => en;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function rawMarket(id, label, { bid, ask, end = NOW + 5 * DAY, liquidity = 50000, fees = false, rewards = null, question = null } = {}) {
  return {
    id, conditionId: cid(id), slug: `m-${id}`, question: question || `Will ${label} happen?`, groupItemTitle: label,
    clobTokenIds: JSON.stringify([`${id}y`, `${id}n`]), outcomes: JSON.stringify(["Yes", "No"]), outcomePrices: JSON.stringify([String(ask), String(1 - ask)]),
    bestBid: bid, bestAsk: ask, liquidity: String(liquidity), acceptingOrders: true, closed: false, endDate: iso(end),
    feesEnabled: fees, feeSchedule: fees ? { rate: 0.02, exponent: 1 } : undefined,
    ...(rewards ? { rewardsMinSize: rewards.minSize, rewardsMaxSpread: rewards.maxSpread } : {}),
  };
}
const event = (over) => MK.compactEvent({ id: "e1", slug: "e-1", title: "Who wins?", endDate: iso(NOW + 5 * DAY), tags: [{ slug: "politics" }], markets: [], ...over });
const bk = (token, bids, asks, minSize = 5) => ({ token, bids, asks, minSize, tick: 0.01 });

async function main() {
  // --- models ---------------------------------------------------------------------------------------------------
  {
    near(M.normCdf(0), 0.5, 1e-7);
    near(M.normCdf(1.96), 0.975, 1e-3);
    assert.strictEqual(M.normCdf(Infinity), 1);
    const st = 0.5 * Math.sqrt(30 * DAY / M.YEAR_MS);
    near(M.probAbove(100, 100, 0.5, 30 * DAY), M.normCdf(-st / 2), 1e-12);
    assert.strictEqual(M.probAbove(101, 100, 0.5, 0), 1);
    assert.strictEqual(M.probAbove(100, 100, 0, DAY), null);
    near(M.probBetween(100, 90, 110, 0.5, 7 * DAY), M.probAbove(100, 90, 0.5, 7 * DAY) - M.probAbove(100, 110, 0.5, 7 * DAY), 1e-12);
    assert.strictEqual(M.probTouch(100, 100, 0.5, DAY), 1);
    const touch = M.probTouch(100, 110, 0.6, 30 * DAY), above = M.probAbove(100, 110, 0.6, 30 * DAY);
    assert.ok(touch > above && touch < 1, "touching a level is likelier than ending above it");

    assert.deepStrictEqual(M.parseCryptoEvent("Bitcoin above ___ on November 5?"), { asset: "BTC", kind: "above" });
    assert.deepStrictEqual(M.parseCryptoEvent("Ethereum price on November 5?"), { asset: "ETH", kind: "range" });
    assert.deepStrictEqual(M.parseCryptoEvent("What price will Solana hit in November?"), { asset: "SOL", kind: "touch" });
    assert.strictEqual(M.parseCryptoEvent("Bitcoin Up or Down - November 4"), null);
    assert.deepStrictEqual(M.parseStrike("↑100k"), { dir: "up", k: 100000 });
    assert.deepStrictEqual(M.parseStrike("↓ $95,000"), { dir: "down", k: 95000 });
    assert.deepStrictEqual(M.parseStrike("$96,000-$98,000"), { lo: 96000, hi: 98000 });
    assert.deepStrictEqual(M.parseStrike("<90k"), { lo: null, hi: 90000 });
    assert.deepStrictEqual(M.parseStrike("104,000"), { k: 104000 });
    assert.strictEqual(M.parseStrike("Trump"), null);
    assert.deepStrictEqual(M.parseBucket("54-55°F"), { lo: 54, hi: 55, unit: "F" });
    assert.deepStrictEqual(M.parseBucket("13°C or below"), { lo: -Infinity, hi: 13, unit: "C" });
    assert.deepStrictEqual(M.parseBucket("20 °C or higher"), { lo: 20, hi: Infinity, unit: "C" });
    assert.deepStrictEqual(M.parseBucket("17°C"), { lo: 17, hi: 17, unit: "C" });
    assert.strictEqual(M.parseBucket("warm"), null);
    near(M.metarTemp({ rawOb: "KLGA 041251Z 31010KT 10SM FEW250 12/M03 A3012 RMK AO2 SLP199 T01221028", temp: 12 }), 12.2);
    near(M.metarTemp({ rawOb: "EGLL 041250Z 25012KT 9999 SCT030 M01/M03 Q1022 RMK T10111028" }), -1.1);
    assert.strictEqual(M.metarTemp({ rawOb: "XXXX", temp: 7 }), 7);
    assert.strictEqual(M.median([3, 1, 2]), 2);
    assert.strictEqual(M.median([4, 1, 3, 2]), 2.5);
    assert.strictEqual(M.median([]), null);
    const at = M.parseDateLabel("March 31", Date.UTC(2027, 6, 1));
    assert.strictEqual(at, Date.UTC(2027, 2, 31, 23, 59));
    assert.strictEqual(M.parseDateLabel("by December 31, 2026", null), Date.UTC(2026, 11, 31, 23, 59));
    assert.strictEqual(M.parseDateLabel("Smarch 3", null), null);
  }

  // weather: a parsed event, a finished day (the observed high is final) and a day still running
  {
    const wxEv = event({
      id: "wx", title: "Highest temperature in NYC on November 4?", slug: "highest-temperature-in-nyc-on-november-4-2026",
      description: "This market resolves on the highest temperature recorded at LaGuardia Airport (KLGA) on that date.",
      tags: [{ slug: "weather" }, { slug: "daily-temperature" }],
      markets: [rawMarket("w1", "53°F or below", { bid: 0.1, ask: 0.12 }), rawMarket("w2", "54-55°F", { bid: 0.6, ask: 0.62 }), rawMarket("w3", "56°F or higher", { bid: 0.25, ask: 0.27 })],
    });
    const info = M.parseWeatherEvent(wxEv);
    assert.deepStrictEqual({ kind: info.kind, icao: info.icao, date: info.date, unit: info.unit, n: info.buckets.length }, { kind: "max", icao: "KLGA", date: "2026-11-04", unit: "F", n: 3 });
    assert.strictEqual(M.parseWeatherEvent({ ...wxEv, description: "Hong Kong Observatory" }), null);
    assert.strictEqual(wxEv.sector, "weather");

    const day = Date.UTC(2026, 10, 3);
    const hours = (start) => Array.from({ length: 24 }, (_, h) => iso(start + h * 3600000).slice(0, 16));
    const buckets = [{ market: "lo", lo: -Infinity, hi: 11 }, { market: "mid", lo: 12, hi: 12 }, { market: "hi", lo: 13, hi: Infinity }];
    const obs = Array.from({ length: 24 }, (_, h) => ({ t: day + h * 3600000 + 51 * 60000, c: h === 15 ? 12.2 : 8 }));
    const done = M.weatherProbabilities({ kind: "max", date: "2026-11-03", unit: "C", buckets, times: hours(day), members: [], offsetSec: 0, obs, now: NOW });
    assert.deepStrictEqual(done.buckets.map((b) => b.p), [0, 1, 0]);
    assert.strictEqual(done.observed, 12.2);
    assert.strictEqual(done.remainingHours, 0);
    assert.strictEqual(M.weatherProbabilities({ kind: "max", date: "2026-11-03", unit: "C", buckets, times: hours(day), members: [], offsetSec: 0, obs: [], now: NOW }), null);

    const today = Date.UTC(2026, 10, 4);
    const times = hours(today);
    const members = Array.from({ length: 20 }, (_, i) => times.map(() => 14.5 + (i - 9.5) * 0.05));
    const open = M.weatherProbabilities({ kind: "max", date: "2026-11-04", unit: "C", times, members, offsetSec: 0, obs: [{ t: NOW - 3600000, c: 10 }], now: NOW,
      buckets: [{ market: "a", lo: -Infinity, hi: 13 }, { market: "b", lo: 14, hi: 15 }, { market: "c", lo: 16, hi: Infinity }] });
    near(open.buckets.reduce((s, b) => s + b.p, 0), 1, 1e-9);
    assert.ok(open.buckets[1].p > 0.6, "most of the mass is in the 14–15 °C bucket");
    assert.strictEqual(open.remainingHours, 11);
    assert.strictEqual(M.weatherProbabilities({ kind: "max", date: "2026-11-04", unit: "C", times, members: members.slice(0, 5), offsetSec: 0, obs: [], now: NOW, buckets }), null);
    assert.deepStrictEqual(open.buckets.map((b) => b.decided), [false, false, false], "10 °C so far settles nothing of a 14–15 °C day");
    {
      // decided: the observations alone settle a bucket, with half a degree of margin for whole-degree reports
      const wb = [{ lo: -Infinity, hi: 11, market: "a" }, { lo: 12, hi: 13, market: "b" }, { lo: 14, hi: 15, market: "c" }, { lo: 16, hi: Infinity, market: "d" }];
      const run = (kind, c, over = {}) => M.weatherProbabilities({ kind, date: "2026-11-04", unit: "C", buckets: wb, times, members, offsetSec: 0, obs: [{ t: NOW - 3600000, c }], now: NOW, ...over });
      const flags = (r) => r.buckets.map((b) => b.decided);
      assert.deepStrictEqual(flags(run("max", 16.6)), [true, true, true, true], "a 16.6 °C high so far: ≥ 16 is certain, the rest out of reach");
      assert.deepStrictEqual(flags(run("max", 15.8)), [true, true, false, false], "15.8 °C may still read 15 or 16");
      assert.deepStrictEqual(flags(run("min", 10.2)), [true, true, true, true], "a 10.2 °C low so far: ≤ 11 is certain");
      assert.deepStrictEqual(flags(run("min", 12.3)), [false, false, true, true]);
      // the day is over: the high is the observed 12.2 °C, give or take half a degree, so only "≤ 11" is settled
      assert.deepStrictEqual(done.buckets.map((b) => b.decided), [true, false, false]);
    }

    const sw = SC.screenWeather([{ event: wxEv, info, result: { buckets: info.buckets.map((b, i) => ({ market: b.market, p: [0.05, 0.8, 0.15][i] })), observed: 50, bias: 0.2, sigma: 0.7, members: 51 } }], 0.02);
    assert.deepStrictEqual(sw.map((c) => c.key), ["wx:w2:yes", "wx:w3:no"]);
    const sure = { ...wxEv.markets[0], bid: 0.995, ask: 0.999 };   // the market already knows: YES at 99.5¢
    assert.strictEqual(SC.screenWeather([{ event: wxEv, info, result: { buckets: [{ market: sure, p: 0 }], observed: 50, bias: 0, sigma: 0.7, members: 51 } }], 0.02).length, 0,
      "never buy a side priced under 3¢");
    // the model counts 40% against the mid: 0.61 + 0.4 × (0.80 − 0.61) = 0.686 against the 0.62 ask
    near(sw[0].hint, 0.066);
    near(sw[0].prob, 0.686);
    assert.deepStrictEqual(sw[0].shrink, { p: 0.8, w: 0.4, maxGap: 0.25 });
    assert.ok(sw[0].model.startsWith("max KLGA 2026-11-04"));
    assert.ok(sw[0].model.endsWith("model 0.800 → 0.686 with the market 0.610"), sw[0].model);
    near(SC.weatherBlend(0.8, 0.61), 0.686);
    // 25 points from the market is a model error, not an edge: 0.90 against a 0.61 mid is left alone
    const far = SC.screenWeather([{ event: wxEv, info, result: { buckets: info.buckets.map((b, i) => ({ market: b.market, p: [0.05, 0.9, 0.05][i] })), observed: 50, bias: 0, sigma: 0.7, members: 51 } }], 0.02);
    assert.deepStrictEqual(far.map((c) => c.key), ["wx:w3:no", "wx:w1:no"], "w2 is 29 points off the market");
    // ...unless the observations already settle the bucket: then the model's 0 or 1 stands as it is
    const settled = SC.screenWeather([{ event: wxEv, info, result: { buckets: [{ market: wxEv.markets[2], p: 0, decided: true }], observed: 56, bias: 0, sigma: 0.7, members: 51 } }], 0.02);
    assert.deepStrictEqual(settled.map((c) => [c.key, c.prob, c.shrink]), [["wx:w3:no", 0.99, null]], "still never quite 100%");
    assert.ok(settled[0].model.endsWith("p=0.000 by observation"));
    // a quote-less bucket has no mid to lean on
    const bare = { ...wxEv.markets[1], bid: 0, ask: 0 };
    assert.strictEqual(SC.screenWeather([{ event: wxEv, info, result: { buckets: [{ market: bare, p: 0.8 }], observed: 50, bias: 0, sigma: 0.7, members: 51 } }], 0.02).length, 0);
  }

  // --- Polymarket data ------------------------------------------------------------------------------------------
  {
    const m0 = MK.compactMarket(rawMarket("7", "Yes", { bid: 0.4, ask: 0.42, fees: true, rewards: { minSize: 50, maxSpread: 3.5 } }));
    assert.deepStrictEqual([m0.yes, m0.no, m0.price, m0.bid, m0.ask, m0.liquidity, m0.accepting], ["7y", "7n", 0.42, 0.4, 0.42, 50000, true]);
    assert.deepStrictEqual(m0.fee, { rate: 0.02, exponent: 1 });
    assert.deepStrictEqual(m0.rewards, { minSize: 50, maxSpread: 3.5 });
    assert.strictEqual(MK.compactMarket({ ...rawMarket("8", "x", { bid: 0.1, ask: 0.2 }), feesEnabled: true, feeSchedule: null }).fee.rate, 0.05, "an unpublished rate is priced at 5%");
    assert.strictEqual(MK.compactEvent({ id: "x", markets: [{ id: "1", clobTokenIds: "not json" }] }).markets.length, 0);
    assert.strictEqual(MK.sectorOf(["nba", "politics"]), "sports");
    assert.strictEqual(MK.sectorOf([]), "other");

    const book = MK.normalizeBook({ asset_id: "t", bids: [{ price: "0.40", size: "10" }, { price: "0.45", size: "5" }, { price: "1", size: "3" }],
      asks: [{ price: "0.6", size: "1" }, { price: "0.5", size: "2" }], min_order_size: "5", tick_size: "0.01" });
    assert.deepStrictEqual(book.bids, [[0.45, 5], [0.4, 10]]);
    assert.deepStrictEqual(book.asks, [[0.5, 2], [0.6, 1]]);
    assert.deepStrictEqual(MK.mirror(book).asks, [[0.55, 5], [0.6, 10]]);
    assert.deepStrictEqual(MK.mirror(book).bids, [[0.5, 2], [0.4, 1]]);
    assert.strictEqual(MK.normalizeBook({}), null);

    const calls = [];
    const net = {
      async json(url, opts = {}) {
        calls.push({ url, opts });
        if (url.endsWith("/books")) {   // like the CLOB: unknown or closed tokens are left out, the rest is answered
          return opts.body.filter((b) => b.token_id !== "gone").map((b) => ({ asset_id: b.token_id, bids: [{ price: "0.3", size: "10" }], asks: [{ price: "0.31", size: "10" }] }));
        }
        if (url.includes("/markets?")) {
          return [{ conditionId: cid(1), closed: true, outcomePrices: "[\"1\",\"0\"]", umaResolutionStatus: "resolved" },
            { conditionId: cid(2), closed: true, outcomePrices: "[\"0.52\",\"0.48\"]" }, { conditionId: cid(3), closed: false, outcomePrices: "[\"0\",\"1\"]" }];
        }
        throw new Error(`unexpected ${url}`);
      },
    };
    const books = await MK.fetchBooks(net, ["a", "b", "a", "gone", null], NOW);
    assert.deepStrictEqual([...books.keys()], ["a", "b"]);
    assert.strictEqual(books.get("a").fetchedAt, NOW);
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.strictEqual(calls[0].opts.body.length, 3);
    calls.length = 0;
    await MK.fetchBooks(net, Array.from({ length: 450 }, (_, i) => `t${i}`), NOW);
    assert.deepStrictEqual(calls.map((c) => c.opts.body.length), [200, 200, 50]);
    const res = await MK.fetchResolutions(net, [cid(1), cid(2), cid(3), "not-a-condition"]);
    assert.deepStrictEqual([...res.entries()], [[cid(1), { prices: [1, 0], status: "resolved" }]]);
    assert.ok(calls[calls.length - 1].url.includes("closed=true"));

    const pages = [];
    const pageNet = {
      async json(url) {
        pages.push(url);
        const second = url.includes("after_cursor=c%3D2");
        return { events: Array.from({ length: second ? 3 : 100 }, (_, i) => ({ id: `${second ? "b" : "a"}${i}`, title: "t", markets: [] })), next_cursor: second ? null : "c=2" };
      },
    };
    assert.strictEqual((await MK.fetchTopEvents(pageNet, { pages: 3 })).length, 103);
    assert.strictEqual(pages.length, 2);
    const byId = [];
    await MK.fetchEventsById({ async json(url) { byId.push(url); return []; } }, Array.from({ length: 25 }, (_, i) => String(i)));
    assert.strictEqual(byId.length, 2);
    assert.ok(byId[0].includes("id=0&id=1&"));
  }

  // --- the paper book -------------------------------------------------------------------------------------------
  {
    const asks = [[0.5, 10], [0.6, 10]];
    const free = { rate: 0 };
    const w = walkCost(asks, 15, free);
    near(w.cost, 8);
    assert.strictEqual(w.fees, 0);
    assert.strictEqual(walkCost(asks, 25, free), null);
    const f1 = simulateBuy(asks, { budgetUsd: 7.5, limit: 0.6, fee: free });
    assert.deepStrictEqual([f1.shares, f1.worst], [14.16, 0.6]);
    near(f1.cost, 7.496);
    assert.strictEqual(simulateBuy(asks, { limit: 0.55, fee: free }).shares, 10);
    assert.strictEqual(simulateBuy(asks, { shares: 3, fee: free, minSize: 5 }), null);
    const f2 = simulateBuy([[0.5, 100]], { budgetUsd: 10.1, fee: { rate: 0.02, exponent: 1 } });
    assert.deepStrictEqual([f2.shares, f2.cost, f2.fees], [20, 10, 0.1]);

    const state = freshBook(100, NOW);
    const pb = new PaperBook(state);
    const ev = event({ markets: [rawMarket("1", "A", { bid: 0.4, ask: 0.5 })] });
    const m = ev.markets[0];
    const pos = pb.open({ agentId: "a1", type: "test", src: "k", event: ev, market: m, side: "yes", fill: { shares: 20, cost: 10, fees: 0.1, avg: 0.5, worst: 0.5 }, prob: 0.6, marketProb: 0.45, now: NOW });
    assert.deepStrictEqual([state.cash, pos.tokenId, pos.entry, pos.outcomeLabel, pos.sector], [89.9, "1y", 0.5, "Yes", "politics"]);
    pb.open({ agentId: "a1", type: "test", src: "k", event: ev, market: m, side: "yes", fill: { shares: 10, cost: 6, fees: 0, avg: 0.6, worst: 0.6 }, prob: 0.7, now: NOW });
    assert.strictEqual(state.positions.length, 1, "the same agent and token add to one position");
    assert.deepStrictEqual([state.positions[0].shares, state.positions[0].prob, state.trades], [30, 0.633333, 2]);
    pb.mark("1y", 0.55, 0.57, NOW + 1);
    near(pb.equity(), 100.7);
    near(pb.exposure(), 16.1);
    near(pb.unrealized(), 0.7);
    pb.mark("1y", 0.2, 0.9, NOW + 2);
    assert.strictEqual(state.positions[0].mark, 0.2, "a wide spread marks at the bid");
    assert.throws(() => pb.open({ agentId: "a2", type: "t", src: "k", event: ev, market: m, side: "no", fill: { shares: 1000, cost: 500, fees: 0, avg: 0.5 }, now: NOW }), /agents_cash_insufficient/);
    const rows = pb.settle(m.conditionId, [1, 0], NOW + 3);
    assert.strictEqual(rows.length, 1);
    near(rows[0].pnl, 13.9);
    near(state.cash, 113.9);
    assert.deepStrictEqual([state.positions.length, state.closed.length, state.realized.a1, state.brier.a1.n], [0, 1, 13.9, 1]);
    near(state.brier.a1.sum, (0.633333 - 1) ** 2);
    near(state.brier.a1.market, 0.3025);
    assert.deepStrictEqual(pb.settle(m.conditionId, [1, 0], NOW + 4), []);
  }

  // --- sizing and limits ----------------------------------------------------------------------------------------
  const cfg = validateConfig({});
  {
    near(kellyStake({ p: 0.6, cost: 0.5, bankroll: 100, fraction: 0.25 }), 5);
    assert.strictEqual(kellyStake({ p: 0.5, cost: 0.5, bankroll: 100, fraction: 0.25 }), 0);
    assert.strictEqual(kellyStake({ p: 0.9, cost: 1, bankroll: 100, fraction: 0.25 }), 0);
    const book = new PaperBook(freshBook(1000, NOW));
    const ev = event({ markets: [rawMarket("1", "A", { bid: 0.4, ask: 0.5 })] });
    const m = ev.markets[0];
    assert.deepStrictEqual(capacity({ config: cfg, book, equity: 1000, agentId: "a1", event: ev, market: m }), { usd: 25, binding: "trade", legUsd: 50 });
    assert.deepStrictEqual(capacity({ config: cfg, book, equity: 1000, agentId: "a1", event: ev, arbitrage: true }), { usd: 100, binding: "trade", legUsd: 50 });
    book.open({ agentId: "a1", type: "t", src: "k", event: ev, market: m, side: "yes", fill: { shares: 80, cost: 40, fees: 0, avg: 0.5 }, now: NOW });
    assert.deepStrictEqual(capacity({ config: cfg, book, equity: 1000, agentId: "a1", event: ev, market: m }), { usd: 10, binding: "market", legUsd: 50 });
    assert.strictEqual(capacity({ config: { ...cfg, sectorMaxPct: 5 }, book, equity: 1000, agentId: "a2", event: ev, market: null }).binding, "sector");

    // one game, two events ("… - More Markets" names its parent; both carry the game id): one per-event limit
    assert.strictEqual(MK.matchKey({ id: "1230776", gameId: 90122498 }), "game:90122498");
    assert.strictEqual(MK.matchKey({ id: "1230838", parentEventId: 1230776 }), "ev:1230776");
    assert.strictEqual(MK.matchKey({ id: "77" }), "ev:77");
    const game = event({ id: "g1", slug: "ucl-aek1-rma-2026-11-04", gameId: 90122498, markets: [rawMarket("g1a", "AEK", { bid: 0.08, ask: 0.09 })] });
    const more = event({ id: "g2", slug: "ucl-aek1-rma-2026-11-04-more-markets", gameId: 90122498, parentEventId: 1230776,
      markets: ["O/U 1.5", "O/U 2.5", "O/U 3.5", "O/U 4.5"].map((label, i) => rawMarket(`g2${i}`, label, { bid: 0.9, ask: 0.91 })) });
    assert.strictEqual(game.match, more.match);
    const mb = new PaperBook(freshBook(1000, NOW));
    mb.open({ agentId: "a5", type: "favorites", src: "k", event: game, market: game.markets[0], side: "no", fill: { shares: 100, cost: 91, fees: 0, avg: 0.91 }, now: NOW });
    assert.strictEqual(mb.s.positions[0].match, "game:90122498");
    assert.deepStrictEqual(capacity({ config: cfg, book: mb, equity: 1000, agentId: "a5", event: more, market: more.markets[0] }), { usd: 9, binding: "event", legUsd: 50 },
      "$91 already in the game leaves $9 of the $100 per event for its other event");
    const other = event({ id: "g3", gameId: 777, markets: [rawMarket("g3a", "X", { bid: 0.9, ask: 0.91 })] });
    assert.strictEqual(capacity({ config: cfg, book: mb, equity: 1000, agentId: "a5", event: other, market: other.markets[0] }).binding, "trade");
    const legacy = new PaperBook(freshBook(1000, NOW));   // a position stored before matches: its own event
    legacy.open({ agentId: "a5", type: "favorites", src: "k", event: { ...more, match: undefined }, market: more.markets[0], side: "yes", fill: { shares: 10, cost: 9.1, fees: 0, avg: 0.91 }, now: NOW });
    assert.strictEqual(legacy.s.positions[0].match, "ev:g2");
    assert.strictEqual(MAX_PER_MATCH, 3);
    for (const [i, m2] of more.markets.slice(0, 2).entries()) mb.open({ agentId: "a5", type: "favorites", src: `k${i}`, event: more, market: m2, side: "yes", fill: { shares: 1, cost: 0.91, fees: 0, avg: 0.91 }, now: NOW });
    assert.strictEqual(matchCount(mb, "a5", more, more.markets[2].id), 3, "three markets of the game are held");
    assert.strictEqual(matchCount(mb, "a5", more, more.markets[0].id), 2, "adding to a market already held is not a new one");
    assert.strictEqual(matchCount(mb, "a4", more, more.markets[2].id), 0, "the cap is per agent");
    assert.strictEqual(haltCheck({ config: cfg, equity: 960, dayStartEquity: 1000, peakEquity: 1000 }), null);
    assert.strictEqual(haltCheck({ config: cfg, equity: 950, dayStartEquity: 1000, peakEquity: 1000 }).reason, "daily_loss");
    assert.strictEqual(haltCheck({ config: cfg, equity: 840, dayStartEquity: 850, peakEquity: 1000 }).reason, "drawdown");
  }

  // --- configuration and stored state ---------------------------------------------------------------------------
  {
    assert.deepStrictEqual(validateConfig({}), { ...DEFAULT_CONFIG });
    assert.strictEqual(validateConfig({ perTradeUsd: 10, minEdgePct: 3 }).perTradeUsd, 10);
    assert.throws(() => validateConfig({ mode: "live" }), /agents_live_requires_certificate/);
    assert.throws(() => validateConfig({ mode: 1 }), /agents_config_invalid/);
    assert.throws(() => validateConfig({ perTradeUsd: 0 }), /agents_config_invalid/);
    assert.throws(() => validateConfig({ maxAgents: 2.5 }), /agents_config_invalid/);
    assert.throws(() => validateConfig({ aiEnabled: "yes" }), /agents_config_invalid/);
    assert.throws(() => validateConfig({ surprise: 1 }), /agents_config_invalid/);
    assert.throws(() => validateConfig({ perTradeUsd: 60 }), /agents_limits_order/);
    assert.throws(() => validateConfig({ capitalUsd: 50 }), /agents_limits_order/);
    assert.throws(() => validateConfig(null), /agents_config_invalid/);
    const st = JSON.parse(JSON.stringify(initialState(cfg, NOW)));
    assert.strictEqual(validateState(st).version, 1);
    assert.throws(() => validateState({ ...st, version: 2 }), /agents_store_corrupt/);
    assert.throws(() => validateState({ ...st, config: { ...st.config, mode: "live" } }), /agents_store_corrupt/);
    assert.throws(() => validateState({ ...st, roster: [...st.roster, st.roster[0]] }), /agents_store_corrupt/);
    assert.throws(() => validateState({ ...st, book: { ...st.book, positions: [{ id: "p1" }] } }), /agents_store_corrupt/);
    assert.throws(() => validateState({ ...st, halt: { reason: "bored", at: NOW } }), /agents_store_corrupt/);
  }

  // --- scanners -------------------------------------------------------------------------------------------------
  {
    const bundleEv = event({ id: "e2", negRisk: true, markets: ["A", "B", "C"].map((l, i) => rawMarket(`b${i}`, l, { bid: 0.3, ask: 0.31 })) });
    const bundles = SC.screenBundles([bundleEv], cfg);
    assert.deepStrictEqual(bundles.map((c) => c.key), ["bundle:yes:e2"]);
    near(bundles[0].hint, 0.07);
    assert.strictEqual(SC.screenBundles([{ ...bundleEv, augmented: true }], cfg).length, 0, "augmented negRisk events have an implicit 'other'");
    const won = { ...bundleEv, markets: bundleEv.markets.map((m, i) => (i ? m : { ...m, closed: true, price: 1 })) };
    assert.strictEqual(SC.screenBundles([won], cfg).length, 0, "a known winner is no arbitrage");
    const noEv = event({ id: "e3", negRisk: true, markets: ["A", "B", "C"].map((l, i) => rawMarket(`n${i}`, l, { bid: 0.36, ask: 0.4 })) });
    const nb = SC.screenBundles([noEv], cfg);
    assert.deepStrictEqual(nb.map((c) => c.key), ["bundle:no:e3"]);
    near(nb[0].hint, 0.04);

    const books = new Map(bundleEv.markets.map((m) => [m.yes, bk(m.yes, [[0.3, 100]], [[0.31, 100]])]));
    const cap = capacity({ config: cfg, book: new PaperBook(freshBook(1000, NOW)), equity: 1000, agentId: "a1", event: bundleEv, arbitrage: true });
    const arb = SC.confirmArbitrage(bundles[0], books, cfg, cap, say);
    assert.strictEqual(arb.orders.length, 3);
    assert.ok(arb.orders.every((o) => o.fill.shares === 100 && o.side === "yes"));
    near(arb.costUsd, 93);
    near(arb.profitUsd, 7);
    assert.strictEqual(arb.prob, 1);
    const small = SC.confirmArbitrage(bundles[0], books, cfg, { usd: 50, binding: "event", legUsd: 50 }, say);
    assert.ok(small.costUsd <= 50 && small.costUsd > 49.9, `sized to the capacity: ${small.costUsd}`);
    const thin = new Map(bundleEv.markets.map((m) => [m.yes, bk(m.yes, [[0.3, 100]], [[0.333, 100]])]));
    assert.ok(/margin is < 0\.5%/.test(SC.confirmArbitrage(bundles[0], thin, cfg, cap, say).skip));
    assert.strictEqual(SC.confirmArbitrage(bundles[0], new Map(), cfg, cap, say).skip, "no book");
    const noBooks = new Map(noEv.markets.map((m) => [m.yes, bk(m.yes, [[0.36, 100]], [[0.4, 100]])]));
    const noArb = SC.confirmArbitrage(nb[0], noBooks, cfg, cap, say);
    assert.ok(noArb.orders.every((o) => o.side === "no" && Math.abs(o.fill.avg - 0.64) < 1e-9), "NO legs buy the mirrored book");
    near(noArb.profitUsd / noArb.costUsd, 2 / 1.92 - 1);

    // "by November 30, 2026" ⊂ "by March 31, 2027": the year comes from the question, never from the event's end
    const rung = (id, label, date, quotes) => rawMarket(id, label, { ...quotes, question: `Will the bill pass by ${date}?` });
    const ladderEv = event({ id: "e4", title: "Will the bill pass by ...?", endDate: iso(Date.UTC(2027, 0, 1)),
      markets: [rung("l1", "November 30", "November 30, 2026", { bid: 0.4, ask: 0.42 }), rung("l2", "March 31", "March 31, 2027", { bid: 0.36, ask: 0.38 })] });
    const ladders = SC.screenLadders([ladderEv], cfg);
    assert.strictEqual(ladders.length, 1);
    assert.deepStrictEqual(ladders[0].legs.map((l) => [l.market.id, l.side]), [["l2", "yes"], ["l1", "no"]]);
    near(ladders[0].hint, 0.02);
    assert.strictEqual(SC.screenLadders([{ ...ladderEv, negRisk: true }], cfg).length, 0);
    const consistent = event({ ...ladderEv, id: "e4b", markets: [rung("l3", "November 30", "November 30, 2026", { bid: 0.08, ask: 0.09 }), rung("l4", "March 31", "March 31, 2027", { bid: 0.62, ask: 0.63 })] });
    assert.strictEqual(SC.screenLadders([consistent], cfg).length, 0, "a later deadline priced higher is no arbitrage");
    const yearless = event({ ...ladderEv, id: "e4c", markets: [rawMarket("l5", "November 30", { bid: 0.62, ask: 0.63 }), rawMarket("l6", "March 31", { bid: 0.08, ask: 0.09 })] });
    assert.strictEqual(SC.screenLadders([yearless], cfg).length, 0, "dates without a year are not rungs");
    const wide = event({ ...ladderEv, id: "e4d", markets: [rung("l7", "November 30", "November 30, 2026", { bid: 0.6, ask: 0.62 }), rung("l8", "March 31", "March 31, 2027", { bid: 0.3, ask: 0.32 })] });
    assert.strictEqual(SC.screenLadders([wide], cfg).length, 0, "a 28¢ gap is a misread, not a gift");
    const strikes = event({ id: "e4e", title: "What price will Ethereum hit in 2026?", endDate: iso(Date.UTC(2027, 0, 1)), tags: [{ slug: "ethereum" }],
      markets: [rawMarket("l9", "↑ 5,500", { bid: 0.008, ask: 0.011, question: "Will Ethereum reach $5,500 by December 31, 2026?" }),
        rawMarket("l10", "↑ 6,000", { bid: 0.015, ask: 0.017, question: "Will Ethereum reach $6,000 by December 31, 2026?" })] });
    assert.deepStrictEqual(SC.screenLadders([strikes], cfg).map((c) => c.label), ["YES ↑ 5,500 + NO ↑ 6,000"], "strike rungs with a deadline in the question");

    const single = event({ id: "e5", markets: [rawMarket("s1", "X", { bid: 0.5, ask: 0.52 })] });
    const sm = single.markets[0];
    const sbooks = new Map([[sm.yes, bk(sm.yes, [[0.5, 1000]], [[0.52, 1000]])]]);
    const capS = { usd: 25, binding: "trade", legUsd: 50 };
    const opts = (over) => ({ cap: capS, prob: 0.62, minEdge: 0.02, fraction: 0.25, bankroll: 150, say, ...over });
    const one = SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts());
    assert.strictEqual(one.orders[0].fill.shares, 15.02);
    near(one.edge, 0.1);
    near(one.marketProb, 0.51);
    assert.ok(/¼-Kelly \$7\.81, limit "per trade" \$25\.00/.test(one.why), one.why);
    assert.strictEqual(SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts({ prob: 0.53 })).skip, "edge 1.0% < 2.0%");
    assert.strictEqual(SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts({ prob: 0.55, bankroll: 10 })).skip, "¼-Kelly $0.16 < $1");
    assert.strictEqual(SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts({ cap: { usd: 0.5, binding: "agent", legUsd: 50 } })).skip, "limit \"agent capital\" used up");
    assert.ok(/^½-Kelly/.test(SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts({ fraction: 0.5 })).why.split("; ")[1]));
    const no = SC.confirmSingle({ market: sm, side: "no" }, sbooks, opts({ prob: 0.6 }));
    assert.deepStrictEqual([no.orders[0].side, no.orders[0].fill.avg], ["no", 0.5]);
    const byPrice = SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts({ prob: (price) => price + 0.015, minEdge: 0.005, bankroll: 1500 }));
    near(byPrice.prob, 0.535);
    assert.strictEqual(SC.confirmSingle({ market: sm, side: "yes" }, sbooks, opts({ prob: (price) => price + 0.015, minEdge: 0.005 })).skip, "below the book's minimum size");

    // a book it could leave: bids on its side, a spread within 20% of the ask, no walk far up the asks
    const books1 = (bids, asks) => new Map([[sm.yes, bk(sm.yes, bids, asks)]]);
    assert.strictEqual(SC.confirmSingle({ market: sm, side: "yes" }, books1([], [[0.52, 1000]]), opts()).skip, "no bids on this side: nobody to sell to");
    assert.strictEqual(SC.confirmSingle({ market: sm, side: "yes" }, books1([[0.4, 1000]], [[0.52, 1000]]), opts()).skip, "spread 0.400–0.520 is wider than 20% of the price");
    assert.ok(SC.confirmSingle({ market: sm, side: "yes" }, books1([[0.42, 1000]], [[0.52, 1000]]), opts()).orders, "a 10¢ spread on 52¢ is 19%: fine");
    const walk = SC.confirmSingle({ market: sm, side: "yes" }, books1([[0.5, 1000]], [[0.52, 5], [0.56, 5], [0.58, 1000]]), opts({ cap: { usd: 25, binding: "trade", legUsd: 50 }, bankroll: 1500 }));
    assert.ok(walk.orders && walk.orders[0].fill.avg <= 0.572 + 1e-9, "the fill stops 10% above the best ask, not at the model's price");
    assert.strictEqual(walk.orders[0].fill.shares, 10, "the 58¢ level is out of reach");
    const cheap = { ...sm, id: "s9" };
    const lossy = SC.confirmSingle({ market: cheap, side: "yes" }, new Map([[cheap.yes, bk(cheap.yes, [[0.085, 1000]], [[0.1, 1000]])]]), opts({ prob: 0.3 }));
    assert.ok(lossy.orders, "a 1.5¢ spread on 10¢ is 15%");
    const lossier = SC.confirmSingle({ market: cheap, side: "yes" }, new Map([[cheap.yes, bk(cheap.yes, [[0.081, 1000]], [[0.1, 5], [0.11, 1000]])]]), opts({ prob: 0.3, bankroll: 1500 }));
    assert.ok(/^entry at 0\.1\d+ with the bid at 0\.081: −2\d\.\d% at once$/.test(lossier.skip), lossier.skip);

    const q = SC.quoteEdge(sm, 0.6);
    assert.strictEqual(q.side, "yes");
    near(q.edge, 0.08);
    const qn = SC.quoteEdge(sm, 0.4);
    assert.deepStrictEqual([qn.side, Math.round(qn.edge * 1e9) / 1e9, qn.prob], ["no", 0.1, 0.6]);

    const fav = event({ id: "e6", title: "Will the incumbent win?", markets: [rawMarket("f1", "Inc", { bid: 0.94, ask: 0.95, end: NOW + 3 * DAY })] });
    assert.deepStrictEqual(SC.screenFavorites([fav], R.DEFAULT_PARAMS.favorites, NOW).map((c) => c.key), ["fav:f1:yes"]);
    assert.strictEqual(SC.screenFavorites([fav], R.DEFAULT_PARAMS.favorites, NOW + 2.99 * DAY).length, 0, "less than an hour left");
    assert.strictEqual(SC.screenFavorites([{ ...fav, title: "Bitcoin Up or Down - November 4" }], R.DEFAULT_PARAMS.favorites, NOW).length, 0);

    const cryptoEv = event({ id: "e7", title: "Bitcoin above ___ on November 6?", endDate: iso(NOW + 2 * DAY), tags: [{ slug: "bitcoin" }],
      markets: [rawMarket("c1", "100,000", { bid: 0.4, ask: 0.42, end: NOW + 2 * DAY }), rawMarket("c2", "150,000", { bid: 0.01, ask: 0.02, end: NOW + 2 * DAY })] });
    assert.deepStrictEqual(SC.screenCrypto([cryptoEv], { BTC: { spot: 100000, sigma: 0.5, source: "test" } }, NOW, 0.02), [], "the ends of a ladder have no neighbour on one side");
    assert.strictEqual(SC.screenCrypto([cryptoEv], {}, NOW, 0.02).length, 0);
    {
      // a ladder priced at σ 0.8 shows no edge to a model on DVOL 0.4: each strike takes the σ of its neighbours…
      const levels = [97000, 98500, 100000, 101500, 103000];
      const fair = levels.map((k) => M.probAbove(100000, k, 0.8, DAY));
      const ladderEv = (shift = () => 0) => event({ id: "e9", title: "Bitcoin above ___ on November 5?", endDate: iso(NOW + DAY), tags: [{ slug: "bitcoin" }],
        markets: levels.map((k, i) => rawMarket(`l${i}`, k.toLocaleString("en-US"), { bid: fair[i] - 0.01 + shift(i), ask: fair[i] + 0.01 + shift(i), end: NOW + DAY })) });
      const dvol = { BTC: { spot: 100000, sigma: 0.4, source: "test" } };
      assert.deepStrictEqual(SC.screenCrypto([ladderEv()], dvol, NOW, 0.02), []);
      const fit = SC.ladderSigma(ladderEv().markets.map((m, i) => ({ mid: (m.bid + m.ask) / 2, prob: (sg) => M.probAbove(100000, levels[i], sg, DAY) })));
      near(fit.sigma, 0.8, 1e-4);
      // …so a strike 9¢ under the strikes around it is found
      const odd = SC.screenCrypto([ladderEv((i) => (i === 3 ? -0.09 : 0))], dvol, NOW, 0.02);
      assert.deepStrictEqual(odd.map((c) => c.key), ["cx:l3:yes"]);
      near(odd[0].prob, fair[3], 1e-3);
      assert.strictEqual(odd[0].model, `BTC above S=100000 (test) σ=0.80 by 3 neighbours (vol 0.40) τ=24.0h p=${fair[3].toFixed(3)}`);
      // a smile is the neighbours' business too: σ rising to the wings is no edge
      const smile = levels.map((k, i) => M.probAbove(100000, k, 0.6 + 0.04 * Math.abs(i - 2), DAY));
      const smiled = event({ id: "e10", title: "Bitcoin above ___ on November 5?", endDate: iso(NOW + DAY), tags: [{ slug: "bitcoin" }],
        markets: levels.map((k, i) => rawMarket(`s${i}`, k.toLocaleString("en-US"), { bid: smile[i] - 0.01, ask: smile[i] + 0.01, end: NOW + DAY })) });
      assert.deepStrictEqual(SC.screenCrypto([smiled], dvol, NOW, 0.02), []);
      // left alone: a ladder end, neighbours that disagree (an inverted ladder), the last two hours
      assert.deepStrictEqual(SC.screenCrypto([ladderEv((i) => (i === 0 ? -0.09 : 0))], dvol, NOW, 0.02), []);
      assert.deepStrictEqual(SC.screenCrypto([ladderEv((i) => [-0.5, -0.3, 0, 0.3, 0.5][i])], dvol, NOW, 0.02), []);
      assert.deepStrictEqual(SC.screenCrypto([ladderEv((i) => (i === 3 ? -0.09 : 0))], dvol, NOW + DAY - 1.5 * 3600000, 0.02), []);
      // touch ladders run per direction
      const ext = { e11: { high: 100500, low: 99500 } };
      const ups = [102000, 104000, 106000, 108000], downs = [98000, 96000, 94000, 92000];
      const touchMk = (k, dir, i, off = 0) => { const f = M.probTouch(100000, k, 0.7, 7 * DAY); return rawMarket(`t${dir}${i}`, `${dir === "up" ? "↑" : "↓"} ${k.toLocaleString("en-US")}`, { bid: f - 0.01 + off, ask: f + 0.01 + off, end: NOW + 7 * DAY }); };
      const touchEv = event({ id: "e11", title: "What price will Bitcoin hit November 4-11?", endDate: iso(NOW + 7 * DAY), tags: [{ slug: "bitcoin" }],
        markets: [...ups.map((k, i) => touchMk(k, "up", i)), ...downs.map((k, i) => touchMk(k, "down", i, i === 1 ? 0.08 : 0))] });
      const touched = SC.screenCrypto([touchEv], { BTC: { spot: 100000, sigma: 0.4, source: "test", extremes: ext } }, NOW, 0.02);
      assert.deepStrictEqual(touched.map((c) => c.key), ["cx:tdown1:no"], "the one rich down-touch, against neighbours of its own direction");
    }
    assert.ok(SC.isModelEvent(cryptoEv));

    const pool = SC.forecastPool([single, fav, cryptoEv], NOW, () => null, { minDays: 2, maxDays: 60 });
    assert.deepStrictEqual(pool.map((x) => x.market.id), ["s1"]);
    assert.strictEqual(SC.forecastPool([single], NOW, () => ({ at: NOW - 3600000, mid: 0.51 })).length, 0, "asked recently at the same price");
    const soon = event({ id: "e8", title: "Will the vote pass?", markets: [rawMarket("r1", "Vote", { bid: 0.86, ask: 0.88, end: NOW + 30 * 3600000 })] });
    assert.deepStrictEqual(SC.resolutionPool([soon, single], NOW, () => null).map((x) => [x.market.id, x.lean]), [["r1", "yes"]]);

    const reward = event({ id: "e9", title: "Will rates fall?", endDate: iso(NOW + 30 * DAY),
      markets: [rawMarket("k1", "Fall", { bid: 0.4, ask: 0.43, end: NOW + 30 * DAY, rewards: { minSize: 20, maxSpread: 4 } })] });
    assert.deepStrictEqual(SC.makerPool([reward, single], NOW).map((x) => x.market.id), ["k1"]);
    const step = SC.makerStep({ yes: 0.45, no: 0.5, size: 10, at: NOW - 60000 }, bk("t", [[0.43, 50]], [[0.44, 50]]), { tick: 0.01 },
      { size: 10, maxShares: 15, inventory: { yes: 10, no: 0 }, now: NOW });
    assert.deepStrictEqual(step.fills, [{ side: "yes", price: 0.45, shares: 10 }]);
    assert.deepStrictEqual(step.quote, { yes: null, no: 0.56, size: 10, at: NOW });
    assert.deepStrictEqual(SC.makerStep(null, bk("t", [[0.43, 50]], [[0.46, 50]]), { tick: 0.01 }, { size: 10, maxShares: 100, inventory: { yes: 0, no: 0 }, now: NOW }).fills, []);
  }

  // --- the roster rules -----------------------------------------------------------------------------------------
  {
    const roster = R.defaultRoster(NOW);
    assert.deepStrictEqual(roster.map((a) => a.type), Object.keys(R.TYPES));
    assert.strictEqual(R.nextId(roster), "a11");
    assert.deepStrictEqual(roster.slice(7).map((a) => [a.id, a.type, a.status, a.note]),
      [["a8", "maker", "retired", "replaced_by_lp"], ["a9", "latency", "active", null], ["a10", "lp_rewards", "active", null]], "LP with rewards replaces the shadow maker");
    assert.strictEqual(R.ensureLanes(roster, NOW), false);
    // a roster saved before the fast lanes: they join with the next ids and the shadow maker retires
    const old = Object.keys(R.TYPES).filter((t) => !R.LANE_TYPES.includes(t)).map((type, i) => ({ ...R.defaultRoster(NOW)[i], status: "active", note: null, pausedAt: null }));
    assert.deepStrictEqual(old.map((a) => a.type).slice(-1), ["maker"]);
    assert.strictEqual(R.ensureLanes(old, NOW + 1), true);
    assert.deepStrictEqual(old.slice(7).map((a) => [a.id, a.type, a.status, a.note]),
      [["a8", "maker", "retired", "replaced_by_lp"], ["a9", "latency", "active", null], ["a10", "lp_rewards", "active", null]]);
    assert.strictEqual(R.ensureLanes(old, NOW + 2), false, "once");
    const loss = { a1: { pnl: -50, settled: 3 } };   // 30% of the agent's $150
    const acts = R.evaluateRoster(roster, loss, cfg, NOW);
    assert.deepStrictEqual(acts, [{ op: "pause", agentId: "a1", reason: "loss_30" }]);
    R.applyRoster(roster, acts[0], NOW);
    assert.deepStrictEqual([roster[0].status, roster[0].pauses], ["paused", 1]);
    assert.deepStrictEqual(R.evaluateRoster(roster, {}, cfg, NOW + 71 * 3600000), []);
    assert.deepStrictEqual(R.evaluateRoster(roster, {}, cfg, NOW + 72 * 3600000), [{ op: "resume", agentId: "a1", reason: "retest_after_72h" }]);
    R.applyRoster(roster, { op: "resume", agentId: "a1", reason: "retest_after_72h" }, NOW + 72 * 3600000);
    assert.deepStrictEqual(R.evaluateRoster(roster, loss, cfg, NOW + 73 * 3600000), [{ op: "retire", agentId: "a1", reason: "loss_30" }]);
    assert.deepStrictEqual(R.evaluateRoster(roster, { a7: { pnl: 0, settled: 40, brier: 0.25, marketBrier: 0.2, brierN: 30 } }, cfg, NOW)[0],
      { op: "pause", agentId: "a7", reason: "brier_worse_than_market" });
    assert.deepStrictEqual(R.evaluateRoster(R.defaultRoster(NOW), { a4: { pnl: 5, settled: 30, brier: 0.3, marketBrier: 0.2, brierN: 30 } }, cfg, NOW)[0],
      { op: "pause", agentId: "a4", reason: "brier_worse_than_market" }, "the weather model too");
    assert.deepStrictEqual(R.evaluateRoster(R.defaultRoster(NOW), { a5: { pnl: 5, settled: 30, brier: 0.3, marketBrier: 0.2, brierN: 30 } }, cfg, NOW), [],
      "favourites carry no probability of their own");
    const manual = R.defaultRoster(NOW);
    Object.assign(manual[1], { status: "paused", pausedAt: NOW - 100 * 3600000, note: "manual" });
    assert.deepStrictEqual(R.evaluateRoster(manual, {}, cfg, NOW), [], "a manual pause is never lifted by the rules");

    const roster2 = R.defaultRoster(NOW);
    assert.deepStrictEqual(R.evaluateRoster(roster2, { a5: { pnl: 10, settled: 25 } }, cfg, NOW), [], "nine agents fill the nine default slots");
    const spawn = R.evaluateRoster(roster2, { a5: { pnl: 10, settled: 25 } }, { ...cfg, maxAgents: 10 }, NOW);
    assert.deepStrictEqual(spawn, [{ op: "spawn", type: "favorites", params: R.VARIANTS.favorites, reason: "variant_of_a5" }]);
    assert.strictEqual(R.applyRoster(roster2, spawn[0], NOW).id, "a11");
    assert.strictEqual(R.allowSuggestion({ op: "pause", agent: "a2" }, roster2, cfg, NOW).ok, true);
    assert.strictEqual(R.allowSuggestion({ op: "resume", agent: "a2" }, roster2, cfg, NOW).reason, "not_paused");
    assert.strictEqual(R.allowSuggestion({ op: "spawn", agent: "favorites" }, roster2, cfg, NOW).reason, "no_slot");
    assert.strictEqual(R.allowSuggestion({ op: "spawn", agent: "arb_bundle" }, roster2, { ...cfg, maxAgents: 16 }, NOW).reason, "no_variant");
    assert.strictEqual(R.allowSuggestion({ op: "spawn", agent: "favorites" }, roster2, { ...cfg, maxAgents: 16 }, NOW).reason, "exists");
    assert.strictEqual(R.allowSuggestion({ op: "delete", agent: "a1" }, roster2, cfg, NOW).reason, "invalid");
    Object.assign(roster2[2], { status: "paused", pausedAt: NOW - 3600000, note: "loss_30" });
    assert.strictEqual(R.allowSuggestion({ op: "resume", agent: "a3" }, roster2, cfg, NOW).reason, "too_early");
    assert.strictEqual(R.allowSuggestion({ op: "resume", agent: "a3" }, roster2, cfg, NOW + DAY).ok, true);
  }

  // --- the language model: replies are data, checked field by field -----------------------------------------------
  {
    assert.throws(() => B.parseReply("no json"), /agents_ai_reply_invalid/);
    assert.throws(() => B.parseReply("{broken"), /agents_ai_reply_invalid/);
    assert.deepStrictEqual(B.parseReply("Sure: {\"a\":1} done"), { a: 1 });
    const vf = B.validForecasts({ forecasts: [{ id: "m1", p: 1, confidence: "high", reason: "x".repeat(300) }, { id: "m1", p: 0.2, confidence: "low" },
      { id: "m2", p: "0.5", confidence: "low" }, { id: "zz", p: 0.5, confidence: "low" }, { id: "m3", p: 0.5, confidence: "sure" }, { id: "m3", p: 1.5, confidence: "low" }] }, new Set(["m1", "m2", "m3"]));
    assert.deepStrictEqual(vf.map((r) => [r.id, r.p, r.reason.length]), [["m1", 0.99, 160]]);
    assert.deepStrictEqual(B.validForecasts({ forecasts: "many" }, new Set(["m1"])), []);
    const vc = B.validChecks({ checks: [{ id: "m1", status: "decided_yes", evidence: 0, reason: "won" }, { id: "m2", status: "decided_no", evidence: 5 }, { id: "m3", status: "maybe" }] },
      [{ id: "m1", headlines: [{ i: 0, title: "A wins" }] }, { id: "m2", headlines: [{ i: 0, title: "B" }] }, { id: "m3", headlines: [] }]);
    assert.deepStrictEqual(vc.map((r) => [r.id, r.status, r.evidence]), [["m1", "decided_yes", "A wins"], ["m2", "undecided", null]]);
    const vp = B.validPlan({ actions: [{ op: "pause", agent: "a1" }, { op: "pause", agent: "a1" }, { op: "spawn", agent: "favorites" }, { op: "resume", agent: "a2" }], note: "n" },
      new Set(["a1", "a2"]), new Set(["favorites"]));
    assert.deepStrictEqual(vp.actions.map((a) => `${a.op} ${a.agent}`), ["pause a1", "spawn favorites"]);
    assert.strictEqual(B.validPlan({ actions: [{ op: "spawn", agent: "a1" }] }, new Set(["a1"]), new Set(["favorites"])).actions.length, 0);

    let asked = null;
    const brain = new B.Brain({ ask: async (query) => {
      asked = query;
      return { content: JSON.stringify({ forecasts: [{ id: "m1", p: 0.7, confidence: "medium", reason: "polls" }], checks: [{ id: "m1", status: "decided_yes", evidence: 1, reason: "r" }],
        actions: [{ op: "pause", agent: "a1", reason: "loses" }], note: "ok" }), costUsd: 0.002, model: "vendor/model" };
    } });
    const out = await brain.forecast([{ id: "m1", question: "Q?", rules: "R", endDate: NOW + 5 * DAY, mid: 0.6, headlines: [{ title: "H", at: NOW }] }], NOW);
    assert.deepStrictEqual(out.rows, [{ id: "m1", p: 0.7, confidence: "medium", reason: "polls" }]);
    assert.deepStrictEqual([out.asked, out.costUsd, out.model, asked.system, asked.maxTokens], [1, 0.002, "vendor/model", B.SYSTEM.forecast, 200]);
    const prompt = JSON.parse(asked.prompt);
    assert.deepStrictEqual([prompt.now, prompt.markets[0].price, prompt.markets[0].headlines[0].title], ["2026-11-04T12:00Z", 0.6, "H"]);
    const big = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, question: "я".repeat(400), rules: "ю".repeat(600), endDate: NOW + 5 * DAY, mid: 0.5,
      headlines: Array.from({ length: 4 }, () => ({ title: "ж".repeat(200), at: NOW })) }));
    const out2 = await brain.forecast(big, NOW);
    assert.ok(out2.asked >= 1 && out2.asked < 8 && Buffer.byteLength(asked.prompt) <= B.MAX_PROMPT_BYTES, `asked ${out2.asked}`);
    asked = null;
    const none = await brain.resolution([{ id: "m1", question: "Q", rules: "", endDate: NOW, lean: "yes", price: 0.9, headlines: [] }], NOW);
    assert.deepStrictEqual([none.rows, asked], [[], null], "no headlines, no question");
    const checked = await brain.resolution([{ id: "m1", question: "Q", rules: "", endDate: NOW, lean: "yes", price: 0.9, headlines: [{ title: "h0", at: NOW }, { title: "h1", at: NOW }] }], NOW);
    assert.deepStrictEqual(checked.rows, [{ id: "m1", status: "decided_yes", evidence: "h1", reason: "r" }]);
    const plan = await brain.plan({ equity: 1000, capital: 1000, variants: ["favorites"], agents: [{ id: "a1", type: "arb_bundle", status: "active", pnl: -10, settled: 12 }] }, NOW);
    assert.deepStrictEqual([plan.actions, plan.note], [[{ op: "pause", agent: "a1", reason: "loses" }], "ok"]);
    const bad = new B.Brain({ ask: async () => ({ content: "nope" }) });
    await assert.rejects(bad.forecast([{ id: "m1", question: "Q", mid: 0.5 }], NOW), /agents_ai_reply_invalid/);
    assert.throws(() => new B.Brain({}), TypeError);
  }

  // --- METAR: the API answers at most 400 rows, so a full batch is asked again station by station --------------------
  {
    const urls = [];
    const net = {
      async json(url) {
        urls.push(url);
        const ids = /ids=([^&]+)/.exec(url)[1].split(",");
        if (ids.length > 1 && ids.includes("KAAA")) return Array.from({ length: 400 }, (_, i) => ({ icaoId: ids[i % ids.length], obsTime: NOW / 1000 - i * 60, rawOb: "X T01201000" }));
        return ids.flatMap((id) => [{ icaoId: id, obsTime: NOW / 1000 - 3600, rawOb: `${id} 041200Z 18/10 RMK T01001000`, metarType: "METAR" },
          { icaoId: id, obsTime: NOW / 1000 - 1800, rawOb: `SPECI ${id} 041230Z 19/10 RMK T01901000`, metarType: "SPECI" }]);
      },
    };
    const got = await new Sources({ net, now: () => NOW }).metars(["KDDD", "KAAA", "KBBB", "KCCC"]);
    assert.strictEqual(urls.length, 5);
    assert.deepStrictEqual(got.get("KAAA"), [{ t: NOW - 3600000, c: 10 }], "the SPECI does not count");
    assert.deepStrictEqual(got.get("KDDD"), [{ t: NOW - 3600000, c: 10 }]);
  }

  // --- news queries ---------------------------------------------------------------------------------------------
  {
    assert.strictEqual(decodeXml("<![CDATA[A &amp; B]]>"), "A & B");
    assert.strictEqual(decodeXml("Tom &quot;T&quot; &#39;x&#39; &lt;b&gt;"), "Tom \"T\" 'x' <b>");
    const q = newsQuery("Will Donald Trump visit China before December 31?");
    assert.ok(q && /Trump/.test(q) && /China/.test(q) && !/\bWill\b/.test(q), q);
    assert.strictEqual(newsQuery(""), "");
  }

  // --- report texts ---------------------------------------------------------------------------------------------
  {
    assert.strictEqual(T.usd(-1234.5), "−$1 234.50");
    assert.strictEqual(T.signed(0.001), "$0.00");
    assert.strictEqual(T.signed(7), "+$7.00");
    assert.strictEqual(T.pct(0.0123), "1.2%");
    assert.strictEqual(T.typeName("weather", "ru"), "Погода");
    const status = { ok: true, mode: "paper", running: true, halt: null, equity: 1007, cash: 1007, startCapital: 1000, pnl: 7, pnlPct: 0.007, dayPnl: 7,
      exposure: 0, openPositions: 0, trades: 3, settled: 3, feesPaid: 0, ai: { available: false, reason: "ai_disabled" },
      agents: [{ id: "a1", type: "arb_bundle", status: "active", pnl: 7, trades: 1, open: 0 }, { id: "a9", type: "favorites", status: "retired", pnl: 0, trades: 0 }] };
    const ru = T.statusText(status, "ru");
    assert.ok(ru.startsWith("Агенты · бумага · работают\nКапитал $1 007.00 (+$7.00 · 0.7%)"), ru);
    assert.ok(ru.includes("a1 Арбитраж наборов: +$7.00") && !ru.includes("a9"));
    assert.ok(T.statusText({ ...status, running: false, halt: { reason: "manual", by: "telegram", at: NOW } }, "en").includes("To clear it: /agents_start or the app."));
    assert.strictEqual(T.statusText({ ok: false, reason: "agents_store_corrupt" }, "en"), "Agents unavailable: agents_store_corrupt");
    assert.ok(T.haltText({ halt: { reason: "manual", by: "telegram" } }, "ru").startsWith("Агенты остановлены — вручную (Telegram)."));
    const daily = T.alertText({ kind: "halt", halt: { reason: "daily_loss", equity: 949.5, limit: 950 } }, "en");
    assert.ok(daily.includes("daily loss: equity $949.50 ≤ $950.00") && daily.includes("next UTC day"));
    assert.ok(T.alertText({ kind: "halt", halt: { reason: "drawdown", equity: 840, limit: 850 } }, "ru").includes("только в приложении"));
    const trade = { kind: "trade", agentId: "a1", type: "arb_bundle", label: "3 × YES", outcome: "3 × YES", legs: 3, costUsd: 93, avg: null, edge: 0.0753 };
    assert.strictEqual(T.alertText({ kind: "trade", row: trade }, "en"), "Agents (paper)\n• a1 Bundle arbitrage: 3 × YES «3 × YES» (3 legs) $93.00 · edge 7.5%");
    const settle = { kind: "settle", agentId: "a5", type: "favorites", label: "Inc", outcome: "Yes", pnl: -9.5 };
    assert.strictEqual(T.tradeLine(settle, "en"), "✗ a5 Favourites: Yes «Inc» → −$9.50");
    const digest = T.alertText({ kind: "digest", minutes: 60, rows: Array.from({ length: 40 }, () => trade).concat([settle]), count: 300, summary: status }, "en");
    assert.ok(digest.startsWith("Agents · 60-minute digest (paper)\nTrades: 40 for $3 720.00") && digest.includes("…and 259 more") && digest.length <= 3800);
    assert.strictEqual(T.alertText({ kind: "roster", op: "spawn", agentId: "a9", type: "favorites", reason: "variant_of_a5" }, "en"), "New agent a9 Favourites: a variant of a5, which earns.");
    assert.ok(T.alertText({ kind: "daily", report: { ok: true, equity: 1007, pnl: 7, totals: { trades: 3, settled: 3, wins: 3, realized: 7, fees: 0 },
      agents: [{ id: "a7", type: "forecast", trades: 2, settled: 2, realized: 1, brier: 0.1, marketBrier: 0.12 }], ai: { calls: 4, spentUsd: 0.01 }, halt: null } }, "en").includes("Brier 0.100/0.120"));
    assert.strictEqual(T.alertText({ kind: "unknown" }, "en"), null);
    assert.strictEqual(T.alertText(null, "en"), null);
    assert.ok(T.alertText({ kind: "trade", row: { ...trade, label: "x".repeat(5000) } }, "en").length <= 3800);
  }

  console.log("agents tests ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
