"use strict";

// The fast lanes on fake sockets, a fake network and a fake clock: the latency rule from a Binance jump to the exit,
// the LP quotes, fills, rewards and the news shield, the ledgers across restarts, and how the desk runs the lanes.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lanes");
const { AgentDesk } = require("./desk");
const R = require("./roster");
const { takerFee } = require("../fees");

const NOW = Date.UTC(2026, 10, 5, 12);
const HOUR = 3600000;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const roots = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-lanes-")); roots.push(dir); return dir; };
const turn = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// A WebSocket that records what it sends and lets the test deliver messages.
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); setImmediate(() => this.onopen && this.onopen()); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; if (this.onclose) this.onclose(); }
  deliver(obj) { this.onmessage({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
}
FakeWS.all = [];
const socket = (re) => FakeWS.all.filter((ws) => re.test(ws.url) && !ws.closed).pop();

const lvl = (rows) => rows.map(([price, size]) => ({ price: String(price), size: String(size) }));

async function main() {
  // --- latency: the core ---------------------------------------------------------------------------------------
  {
    const core = new L.LatencyCore();
    const T = NOW;
    assert.strictEqual(core.trade("btc", T, 100000), null);
    assert.strictEqual(core.trade("btc", T + 900, 100010), null, "no price a second back yet");
    assert.strictEqual(core.trade("btc", T + 1200, 100015), null, "1.5 bps is under the threshold");
    const jump = core.trade("btc", T + 1500, 100030);
    assert.deepStrictEqual([jump.sign, jump.asset], [1, "btc"]);
    near(jump.bps, 3, 0.01);
    assert.strictEqual(core.trade("btc", T + 2500, 100080), null, "one jump per 3 s cooldown");
    const down = core.trade("btc", T + 6000, 99940);
    assert.deepStrictEqual([down.sign, jump.recent, down.recent], [-1, 0, 1], "jumps in the 5 minutes before");
    assert.strictEqual(core.trade("eth", T, 3000), null, "assets outside the rule are ignored");

    const start = T - 60000, w = { slug: "btc-updown-5m-x", asset: "btc", tf: "5m", start, end: start + 300000, up: "UP" };
    assert.strictEqual(core.addWindow(w), true);
    assert.strictEqual(core.addWindow(w), false);
    assert.deepStrictEqual(core.targets({ asset: "btc", T }).map((x) => x.slug), [w.slug]);
    assert.deepStrictEqual(core.targets({ asset: "btc", T: start + 1000 }), [], "not in the first 5 s of a window");
    core.book("UP", T, lvl([[0.52, 40], [0.5, 100]]), lvl([[0.55, 80], [0.6, 100]]));
    core.change("UP", T + 100, "SELL", "0.55", "0");          // the ask is lifted before our order lands
    core.change("UP", T + 100, "SELL", "0.56", "30");
    const win = core.windows.get(w.slug);
    assert.deepStrictEqual(core.at(win, T + 50).slice(1), [0.52, 40, 0.55, 80]);
    assert.deepStrictEqual(core.at(win, T + 150).slice(1), [0.52, 40, 0.56, 30]);
    const e = core.entry(win, 1, T + 150);
    assert.deepStrictEqual([e.px, e.shares], [0.56, 30]);
    near(e.fee, takerFee(30, 0.56, { rate: 0.07 }));
    const d = core.entry(win, -1, T + 150);
    assert.deepStrictEqual([d.px, d.shares], [0.48, 40], "Down is bought at 1 − the Up bid");
    assert.deepStrictEqual(core.exit(win, 1, T + 150), { px: 0.52, shares: 40 });
    assert.deepStrictEqual(core.exit(win, -1, T + 150), { px: 0.44, shares: 30 });
    assert.strictEqual(core.entry(win, 1, T - 1), null, "no book yet");
  }

  // --- latency: the lane from the sockets to the ledger ---------------------------------------------------------
  {
    const root = tmp(), clock = { t: NOW + 60000 }, events = [];
    const s0 = Math.floor(clock.t / 300000) * 300000;
    const slug = `btc-updown-5m-${s0 / 1000}`;
    const net = {
      async json(url) {
        if (url.includes(`slug=${slug}`) && !url.includes("closed=true")) return [{ slug, clobTokenIds: JSON.stringify(["UP", "DN"]), outcomes: JSON.stringify(["Up", "Down"]) }];
        if (url.includes("closed=true")) return [{ umaResolutionStatus: "resolved", outcomePrices: JSON.stringify(["1", "0"]), outcomes: JSON.stringify(["Up", "Down"]) }];
        return [];
      },
    };
    const lane = new L.LatencyLane({ root, net, WebSocketImpl: FakeWS, now: () => clock.t, onEvent: (row) => events.push(row) });
    lane.start({ capitalUsd: 100, perTradeUsd: 20 });
    await turn(5);
    const clob = socket(/ws-subscriptions-clob/), bin = socket(/binance/);
    assert.ok(clob && bin, "both feeds are open");
    assert.ok(/btcusdt@aggTrade/.test(bin.url));
    assert.deepStrictEqual(JSON.parse(clob.sent[0]).assets_ids, ["UP"]);
    const T = clock.t;
    clob.deliver([{ event_type: "book", asset_id: "UP", timestamp: String(T - 5000), bids: lvl([[0.5, 100]]), asks: lvl([[0.52, 100]]) }]);
    clob.deliver({ event_type: "price_change", timestamp: String(T + 9000), price_changes: [{ asset_id: "UP", side: "BUY", price: "0.58", size: "60" }] });
    const agg = (dt, p) => bin.deliver({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", s: "BTCUSDT", T: T + dt, p: String(p) } });
    agg(-1000, 100000);
    clock.t = T + 100;
    agg(0, 100040);                          // +4 bps in a second
    assert.strictEqual(lane.feeds.jumps, 1);
    clock.t = T + 20000;                     // the entry (book at T+150) and the exit (book at T+10 s) are both due
    await turn(1700);
    await turn(5);
    const st = lane.status();
    const shares = Math.floor(20 / 0.52);   // $20 a trade at 52¢
    const fee1 = takerFee(shares, 0.52, { rate: 0.07 }), fee2 = takerFee(shares, 0.58, { rate: 0.07 });
    assert.deepStrictEqual([st.trades, st.settled, st.wins, st.open], [1, 1, 1, 0]);
    near(st.pnl, Math.round((shares * 0.58 - fee2 - (shares * 0.52 + fee1)) * 100) / 100, 0.011);
    assert.strictEqual(st.recent[0].how, "bid_10s");
    const p = lane.period(T - HOUR, T + HOUR);
    assert.deepStrictEqual([p.trades, p.settled, p.wins], [1, 1, 1]);
    near(p.pnl, st.pnl, 0.011);
    near(st.dayPnl, st.pnl, 0.011);
    lane.stop();
    assert.ok(!lane.running && clob.closed && bin.closed, "stop closes the sockets");
    // the ledger survives a restart; the hour is reported once it is over
    const again = new L.LatencyLane({ root, net, WebSocketImpl: FakeWS, now: () => clock.t, onEvent: (row) => events.push(row) });
    assert.deepStrictEqual([again.status().trades, again.status().pnl], [st.trades, st.pnl]);
    clock.t = T + 2 * HOUR;
    again.status();
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual([events[0].lane, events[0].trades, events[0].settled], ["latency", 1, 1]);
    again.status();
    assert.strictEqual(events.length, 1, "each hour once");
    // with nothing to sell into, a position waits for the result
    const held = { id: "h", slug, sign: 1, px: 0.5, shares: 10, fee: 0.1, cost: 5.1, T: T, end: s0 + 300000 };
    again.core = new L.LatencyCore();
    again._exitNow(held, false);
    assert.strictEqual(again.held.length, 1);
    await again._resolve();
    assert.deepStrictEqual([again.held.length, again.status().settled], [0, 2]);
    near(again.ledger.recent.slice(-1)[0].pnl, 10 - 5.1);
    again.reset();
    assert.deepStrictEqual([again.status().trades, again.status().pnl, new L.LatencyLane({ root, net, WebSocketImpl: FakeWS }).status().trades], [0, 0, 0]);
    // the capital limit
    const small = new L.LatencyLane({ root: tmp(), net, WebSocketImpl: FakeWS, now: () => clock.t });
    small.running = true;
    small.limits = { capitalUsd: 10, perTradeUsd: 20 };
    small.core = new L.LatencyCore();
    small.core.addWindow({ slug: "w", asset: "btc", tf: "5m", start: 0, end: clock.t + 300000, up: "U" });
    small.core.book("U", clock.t - 10, lvl([[0.5, 100]]), lvl([[0.52, 100]]));
    small._enter(small.core.windows.get("w"), { T: clock.t, sign: 1, bps: 3 }, 150);
    assert.strictEqual(small.open.length, 0, "a trade bigger than the lane's free capital is skipped");
    // the day's loss stop: 20% of the lane's capital
    const stopEvents = [];
    small.onEvent = (row) => stopEvents.push(row);
    small.limits = { capitalUsd: 100, perTradeUsd: 20 };
    small.ledger.hist.push([Math.floor(clock.t / HOUR), 5, 5, 0, -20, 1]);
    small._enter(small.core.windows.get("w"), { T: clock.t, sign: 1, bps: 3 }, 150);
    assert.strictEqual(small.open.length, 0);
    assert.deepStrictEqual([stopEvents.length, stopEvents[0].op, stopEvents[0].limit, small.status().dayStopped], [1, "day_stop", -20, true]);
    small.ledger.hist[small.ledger.hist.length - 1][4] = -19;
    small.dayStop = null;
    small._enter(small.core.windows.get("w"), { T: clock.t, sign: 1, bps: 3 }, 150);
    assert.strictEqual(small.open.length, 1, "under the limit it trades");
    // the quiet filter (off by default) skips a jump in a busy market
    small.core.p.maxJumps5m = 2;
    let scheduled = 0;
    small.life = { after: () => { scheduled += 1; }, clear() {}, sockets: new Set() };
    small._onJump({ asset: "btc", T: clock.t, sign: 1, bps: 3, recent: 3 }, clock.t + 80);
    assert.strictEqual(scheduled, 0);
    small._onJump({ asset: "btc", T: clock.t, sign: 1, bps: 3, recent: 2 }, clock.t + 80);
    assert.strictEqual(scheduled, 1);
    small.running = false;
  }

  // --- LP: the core ---------------------------------------------------------------------------------------------
  {
    const U = [
      { cid: "c1", tok: "y1", tok2: "n1", slug: "m1", ev: "e1", rate: 8640, v: 0.03, ms: 10, tick: 0.01, size: 20 },
      { cid: "c2", tok: "y2", tok2: "n2", slug: "m2", ev: "e1", rate: 8640, v: 0.03, ms: 10, tick: 0.01, size: 20 },
    ];
    const core = new L.LpCore(U, { pollMs: 10000 });
    const books = (bid, ask) => new Map(["y1", "y2"].map((t) => [t, { bids: lvl([[bid, 100]]), asks: lvl([[ask, 100]]), tick_size: "0.01" }]));
    let t = NOW;
    for (let i = 0; i < 3; i += 1) { assert.strictEqual(core.poll(books(0.49, 0.51), t).rP, 0); t += 10000; }
    assert.strictEqual(core.markets[0].st.bid, null, "no quotes before a fair value");
    const r = core.poll(books(0.49, 0.51), t);
    const m = core.markets[0];
    assert.deepStrictEqual([m.st.bid.px, m.st.ask.px, m.st.bid.rem], [0.49, 0.51, 20]);
    // our 20 at 1¢ from the mid against 100 a side in the book: score (2/3)² each
    const q = (2 / 3) ** 2 * 20, book = (2 / 3) ** 2 * 100;
    near(r.rP, 2 * (q / (q + 2 * book)), 1e-9);
    near(r.rA, 2 * (q / (q + book)), 1e-9);
    // a taker sells into our bid; the NO side of the same market maps onto it
    t += 1000;
    let f = core.trade({ conditionId: "c1", asset: "y1", price: "0.49", side: "SELL", size: "5" }, t);
    assert.deepStrictEqual(f.map((x) => [x.side, x.px, x.q, x.how]), [["bid", 0.49, 5, "trade"]]);
    f = core.trade({ conditionId: "c1", asset: "n1", price: "0.50", side: "BUY", size: "5" }, t);
    assert.deepStrictEqual(f, [], "a NO buy at 50¢ is a YES sale at 50¢, above our bid");
    f = core.trade({ conditionId: "c1", asset: "n1", price: "0.51", side: "BUY", size: "3" }, t);
    assert.deepStrictEqual(f.map((x) => [x.side, x.px, x.q]), [["bid", 0.49, 3]]);
    assert.strictEqual(core.shocks, 0, "1¢ from the mid is no shock");
    assert.deepStrictEqual([m.st.inv, m.st.bid.rem], [8, 12]);
    near(m.st.cash, -8 * 0.49);
    // the book crosses our bid: the rest is filled at our price
    t += 9000;
    f = core.poll(books(0.47, 0.48), t).fills;
    assert.deepStrictEqual(f.filter((x) => x.cid === "c1").map((x) => [x.side, x.q, x.how]), [["bid", 12, "cross"]]);
    assert.strictEqual(m.st.inv, 20);
    // the shield: a trade far from the mid pulls this market and its event sibling 250 ms later, for 5 minutes
    for (let i = 0; i < 6; i += 1) { t += 10000; core.poll(books(0.49, 0.51), t); }
    assert.ok(m.st.ask && core.markets[1].st.bid, "quoting again (leaning against the inventory)");
    assert.ok(m.st.bid === null || m.st.bid.px < 0.49, "the bid backs off with 20 shares held");
    t += 1000;
    f = core.trade({ conditionId: "c2", asset: "y2", price: "0.53", side: "BUY", size: "1" }, t);
    assert.strictEqual(core.shocks, 1);
    f = core.trade({ conditionId: "c1", asset: "y1", price: String(m.st.ask.px), side: "BUY", size: "2" }, t + 200);
    assert.strictEqual(f.length, 1, "within the reaction time the quote still fills");
    f = core.trade({ conditionId: "c1", asset: "y1", price: "0.60", side: "BUY", size: "2" }, t + 300);
    assert.deepStrictEqual(f, [], "pulled");
    assert.strictEqual(m.st.ask, null);
    const before = core.totals().rewardsPess;
    core.poll(books(0.49, 0.51), t + 10000);
    assert.deepStrictEqual([m.st.bid, m.st.ask, core.markets[1].st.bid], [null, null, null]);
    assert.strictEqual(core.totals().rewardsPess, before, "no rewards while pulled");
    assert.strictEqual(core.totals().pulled, 2);
    // totals, the bank of a market that leaves, and a restart from the snapshot
    const tot = core.totals();
    near(tot.mtm, U.reduce((s, u, i) => s + core.markets[i].st.cash + core.markets[i].st.inv * core.markets[i].mk, 0), 0.006);
    const bank0 = core.markets[1];
    core.retire(bank0);
    const next = new L.LpCore([U[0]], { pollMs: 10000 }, core.snapshot(), core.bank);
    near(next.totals().rewardsPess + next.totals().mtm, tot.rewardsPess + tot.mtm, 0.011);
    assert.strictEqual(next.totals().fills, tot.fills);
    next.cancelAll();
    assert.deepStrictEqual([next.markets[0].st.bid, next.markets[0].raw.length], [null, 0]);
    let t2 = t + 400000;
    for (let i = 0; i < 6; i += 1) { t2 += 10000; next.poll(books(0.49, 0.51), t2, { quote: i < 5 }); }
    assert.deepStrictEqual([next.markets[0].st.bid, next.markets[0].st.ask], [null, null], "the loss stop places no quotes");
    assert.ok(next.markets[0].mk != null, "but the marks go on");
  }

  // --- LP: the lane, its universe, results and restarts ------------------------------------------------------------
  {
    const root = tmp(), clock = { t: NOW };
    const mk = (i) => ({ cid: `c${i}`, tok: `y${i}`, tok2: `n${i}`, slug: `m${i}`, ev: `e${i}`, rate: 100, v: 0.03, ms: 10, tick: 0.01, size: 20 });
    let universe = [mk(1), mk(2), mk(3)];
    const gamma = {};
    const net = {
      async json(url, opts = {}) {
        if (url.includes("/books")) return opts.body.map((b) => ({ asset_id: b.token_id, bids: lvl([[0.49, 100]]), asks: lvl([[0.51, 100]]), tick_size: "0.01" }));
        const m = /condition_ids=([^&]+)/.exec(url);
        if (m) return gamma[m[1]] ? [gamma[m[1]]] : [];
        return [];
      },
    };
    const lane = new L.LpLane({ root, net, WebSocketImpl: FakeWS, now: () => clock.t, build: async () => universe.slice() });
    assert.deepStrictEqual([lane.status().pnl, lane.status().running], [0, false]);
    lane.start({ capitalUsd: 100, perMarketUsd: 50 });
    await turn(5);
    assert.ok(lane.running && socket(/ws-live-data/), "RTDS is open");
    for (let i = 0; i < 5; i += 1) { clock.t += 10000; await lane._poll(); }
    assert.strictEqual(lane.status().quoting, 3);
    const ws = socket(/ws-live-data/);
    ws.deliver({ topic: "activity", type: "trades", payload: { conditionId: "c2", asset: "y2", price: 0.49, side: "SELL", size: 5 } });
    ws.deliver({ topic: "activity", type: "trades", payload: { conditionId: "zz", asset: "q", price: 0.49, side: "SELL", size: 5 } });
    assert.deepStrictEqual([lane.rtds.msgs, lane.rtds.ours, lane.status().trades], [2, 1, 1]);
    clock.t += 10000;
    await lane._poll();
    const s1 = lane.status();
    assert.ok(s1.realized > 0 && s1.pnl > 0, "rewards accrue");
    near(lane.period(NOW, clock.t + 1).pnl, s1.pnl, 0.011);
    assert.strictEqual(lane.period(NOW, clock.t + 1).trades, 1);
    // a rebuild: c1 (flat) leaves for the bank, c2 (5 YES held) resolved YES and settles at $1, c4 joins
    universe = [mk(3), mk(4)];
    gamma.c2 = { conditionId: "c2", closed: true, clobTokenIds: JSON.stringify(["y2", "n2"]), outcomePrices: JSON.stringify(["1", "0"]) };
    const pnlBefore = s1.pnl, c2 = lane.core.byCid.get("c2");
    const expected = pnlBefore + 5 * (1 - c2.mk);
    await lane._universe(true);
    assert.deepStrictEqual(lane.core.markets.map((x) => x.cid), ["c3", "c4"]);
    near(lane.status().pnl, expected, 0.011);
    assert.strictEqual(lane.status().trades, 1, "the fill count stays with the bank");
    // the same, but unresolved: the market keeps quoting until its inventory is gone
    lane.core.byCid.get("c3").st.inv = 4;
    universe = [mk(4)];
    await lane._universe(true);
    assert.deepStrictEqual(lane.core.markets.map((x) => x.cid), ["c4", "c3"]);
    const s2 = lane.status();
    lane.stop();
    assert.ok(ws.closed && !lane.running);
    const again = new L.LpLane({ root, net, WebSocketImpl: FakeWS, now: () => clock.t, build: async () => universe.slice() });
    near(again.status().pnl, s2.pnl, 0.011);
    assert.strictEqual(again.status().quoting, 0, "a restarted lane has no quotes until fresh prices");
    again.reset();
    assert.deepStrictEqual([again.status().pnl, fs.existsSync(path.join(root, "lp.json"))], [0, false]);
    // a failed build waits ten minutes before the next try
    const failing = new L.LpLane({ root: tmp(), net, WebSocketImpl: FakeWS, now: () => clock.t, build: async () => [] });
    failing.start({ capitalUsd: 100 });
    await turn(5);
    assert.deepStrictEqual([failing.running, failing.error], [false, "agents_lane_no_markets"]);
    failing.start({ capitalUsd: 100 });
    assert.strictEqual(failing.running, false);
    clock.t += 11 * 60000;
    failing.start({ capitalUsd: 100 });
    assert.strictEqual(failing.running, true);
    await turn(5);
  }

  // --- the desk runs the lanes ----------------------------------------------------------------------------------
  {
    class FakeLane {
      constructor(type) { this.type = type; this.running = false; this.starts = []; this.resets = 0; this.pnl = 0; this.trades = 0; }
      start(opts) { this.running = true; this.starts.push(opts); }
      stop() { this.running = false; }
      reset() { this.stop(); this.resets += 1; this.pnl = 0; this.trades = 0; }
      period() { return { trades: this.trades, settled: 1, wins: 1, pnl: this.pnl, fees: 0.25 }; }
      status() { return { type: this.type, running: this.running, error: null, trades: this.trades, settled: 1, wins: 1, realized: this.pnl, unrealized: 0, pnl: this.pnl, dayPnl: this.pnl, fees: 0.25, open: 1, exposure: 10 }; }
    }
    const net = { json: async () => [], text: async () => "" };
    const clock = { t: NOW };
    const lanes = { latency: new FakeLane("latency"), lp_rewards: new FakeLane("lp_rewards") };
    const root = path.join(tmp(), "agents");
    // without auto-tick (tests, a desk driven from outside) the lanes never start
    const manual = new AgentDesk({ root: path.join(tmp(), "agents"), net, now: () => clock.t, autoTick: false, lanes });
    manual.start({});
    manual.setContext({ active: true });
    assert.deepStrictEqual([lanes.latency.running, lanes.lp_rewards.running], [false, false]);
    manual.dispose();

    const desk = new AgentDesk({ root, net, now: () => clock.t, autoTick: true, tickMs: 3600000, lanes });
    desk.setContext({ active: true });
    assert.strictEqual(lanes.latency.running, false, "a stopped desk keeps its lanes off");
    desk.start({});
    assert.deepStrictEqual([lanes.latency.running, lanes.lp_rewards.running], [true, true]);
    assert.deepStrictEqual(lanes.latency.starts[0], { capitalUsd: 150, perTradeUsd: 25, perMarketUsd: 50, params: {} });
    lanes.latency.pnl = 12.5;
    lanes.latency.trades = 3;
    lanes.lp_rewards.pnl = -2.5;
    let s = desk.status();
    const a9 = s.agents.find((a) => a.id === "a9"), a10 = s.agents.find((a) => a.id === "a10");
    assert.deepStrictEqual([a9.type, a9.pnl, a9.trades, a9.settled, a9.open, a9.exposure, a9.lane.running], ["latency", 12.5, 3, 1, 1, 10, true]);
    assert.deepStrictEqual([a10.type, a10.pnl], ["lp_rewards", -2.5]);
    assert.deepStrictEqual([s.equity, s.pnl, s.dayPnl, s.trades, s.lanes.latency.pnl], [1010, 10, 10, 3, 12.5]);
    assert.strictEqual(s.agents.find((a) => a.id === "a8").status, "retired");
    const day = desk.report({ period: "day" });
    assert.deepStrictEqual([day.agents.find((a) => a.id === "a9").realized, day.agents.find((a) => a.id === "a9").trades, day.equity], [12.5, 3, 1010]);
    assert.throws(() => desk.configure({ capitalUsd: 2000 }), /agents_reset_required/, "the lanes have traded");
    desk.configure({ perTradeUsd: 10 });
    assert.deepStrictEqual([lanes.latency.running, lanes.latency.starts.length, lanes.latency.starts[1].perTradeUsd], [true, 2, 10], "new limits restart the lanes");
    desk.agent({ id: "a9", action: "pause" });
    assert.deepStrictEqual([lanes.latency.running, lanes.lp_rewards.running], [false, true], "a paused agent's lane stops");
    desk.agent({ id: "a9", action: "resume" });
    assert.strictEqual(lanes.latency.running, true);
    desk.kill({});
    assert.deepStrictEqual([lanes.latency.running, lanes.lp_rewards.running], [false, false], "the emergency stop stops the lanes");
    desk.resume({});
    assert.strictEqual(lanes.lp_rewards.running, true);
    // a lane's loss counts toward the daily stop
    lanes.lp_rewards.pnl = -70;
    await desk.tick();
    s = desk.status();
    assert.deepStrictEqual([s.halt && s.halt.reason, lanes.latency.running, lanes.lp_rewards.running], ["daily_loss", false, false]);
    assert.ok(s.journal.some((r) => r.kind === "lane" && r.op === "stop" && r.agentId === "a10"));
    desk._laneEvent({ lane: "latency", hour: "2026-11-05T11:00:00.000Z", trades: 4, pnl: 1.2 });
    assert.deepStrictEqual((({ kind, op, agentId, trades }) => ({ kind, op, agentId, trades }))(desk.status().journal[0]), { kind: "lane", op: "hour", agentId: "a9", trades: 4 });
    desk.setContext({ active: false });
    desk.reset({ confirm: true });
    assert.deepStrictEqual([lanes.latency.resets, lanes.lp_rewards.resets, desk.status().equity], [1, 1, 1000]);
    desk.dispose();

    // a desk saved before the lanes: they join as a9 and a10 and the shadow maker retires
    const oldRoot = path.join(tmp(), "agents");
    const seed = new AgentDesk({ root: oldRoot, net, now: () => clock.t, autoTick: false, lanes: false });
    seed.configure({});
    seed.dispose();
    const saved = JSON.parse(fs.readFileSync(path.join(oldRoot, "desk.json"), "utf8"));
    saved.roster = saved.roster.filter((a) => !R.LANE_TYPES.includes(a.type)).map((a) => ({ ...a, status: "active", note: null, pausedAt: null }));
    fs.writeFileSync(path.join(oldRoot, "desk.json"), JSON.stringify(saved));
    const migrated = new AgentDesk({ root: oldRoot, net, now: () => clock.t, autoTick: false, lanes: false });
    assert.deepStrictEqual(migrated.status().agents.slice(7).map((a) => [a.id, a.type, a.status]),
      [["a8", "maker", "retired"], ["a9", "latency", "active"], ["a10", "lp_rewards", "active"]]);
    assert.deepStrictEqual(migrated.status().lanes, {});
    migrated.configure({});
    migrated.dispose();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(oldRoot, "desk.json"), "utf8")).roster.length, 10);
  }

  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  console.log("agents lanes tests ok");
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
