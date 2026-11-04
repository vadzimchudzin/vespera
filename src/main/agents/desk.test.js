"use strict";

// The agents desk end to end on a fake network and a fake clock: paper trades, settlement, the automatic and manual
// stops, the Telegram restriction, persistence, a damaged store, configuration and the language model.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AgentDesk, validateState } = require("./desk");
const { GAMMA, CLOB } = require("./market");
const { SYSTEM } = require("./brain");

const NOW = Date.UTC(2026, 10, 4, 12);
const MIN = 60000;
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const cid = (id) => `0x${Buffer.from(String(id)).toString("hex").padStart(64, "0")}`;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const roots = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-agents-"));
  roots.push(dir);
  return path.join(dir, "agents");
};

function market(id, label, { bid, ask, end = NOW + 5 * DAY, liquidity = 50000 } = {}) {
  return {
    id, conditionId: cid(id), slug: `m-${id}`, question: `Will ${label} win the award?`, groupItemTitle: label,
    clobTokenIds: JSON.stringify([`${id}y`, `${id}n`]), outcomes: JSON.stringify(["Yes", "No"]), outcomePrices: JSON.stringify([String(ask), String(1 - ask)]),
    bestBid: bid, bestAsk: ask, liquidity: String(liquidity), acceptingOrders: true, closed: false, endDate: iso(end), feesEnabled: false,
  };
}
const book = (token, bid, ask, size = 100) => ({ asset_id: token, bids: [{ price: String(bid), size: String(size) }], asks: [{ price: String(ask), size: String(size) }],
  min_order_size: "5", tick_size: "0.01" });
const offline = (code = "agents_source_unavailable") => Object.assign(new Error(code), { code });

// Polymarket and the news as the desk sees them; everything else is offline.
function world() {
  const w = {
    events: [], books: {}, resolved: [], rss: "<rss><channel></channel></rss>", down: null, log: [],
    net: {
      async json(url, opts = {}) {
        w.log.push(url);
        if (w.down && w.down.test(url)) throw offline("agents_http_503");
        if (url.startsWith(`${GAMMA}/events/keyset?`)) return { events: w.events, next_cursor: null };
        if (url.startsWith(`${GAMMA}/events?id=`)) {
          const ids = [...url.matchAll(/[?&]id=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
          return w.events.filter((e) => ids.includes(e.id));
        }
        if (url.startsWith(`${GAMMA}/events?`)) return [];
        if (url.startsWith(`${GAMMA}/markets?`)) return w.resolved;
        if (url === `${CLOB}/books`) return opts.body.map((b) => w.books[b.token_id]).filter(Boolean);
        throw offline();
      },
      async text(url) {
        w.log.push(url);
        if (url.startsWith("https://news.google.com/")) return w.rss;
        throw offline();
      },
    },
  };
  return w;
}

// One award, three nominees, the YES set at 93¢: a bundle arbitrage worth $7 on 100 shares a leg.
function bundleWorld() {
  const w = world();
  w.events = [{ id: "e1", slug: "who-wins", title: "Who wins the award?", negRisk: true, endDate: iso(NOW + 5 * DAY), tags: [{ slug: "culture" }],
    markets: ["A", "B", "C"].map((label, i) => market(`b${i}`, label, { bid: 0.3, ask: 0.31 })) }];
  setBooks(w, 0.3, 0.31);
  return w;
}
function setBooks(w, bid, ask) {
  for (const i of [0, 1, 2]) w.books[`b${i}y`] = book(`b${i}y`, bid, ask);
}

function makeDesk(w, { clock, root = tmp(), ai = null } = {}) {
  const alerts = [], events = [];
  const desk = new AgentDesk({ root, net: w.net, ai, now: () => clock.t, autoTick: false, locale: () => "en",
    onEvent: (e) => (e.type === "agents_alert" ? alerts.push(e.payload) : events.push(e)) });
  return { desk, alerts, events, root };
}

async function main() {
  // --- a bundle arbitrage from the screen to the payout ----------------------------------------------------------
  {
    const clock = { t: NOW };
    const w = bundleWorld();
    const { desk, alerts, events, root } = makeDesk(w, { clock });
    let s = desk.status();
    assert.deepStrictEqual([s.ok, s.mode, s.running, s.equity, s.agents.length, s.agents[0].capital, s.ai.available, s.ai.reason],
      [true, "paper", false, 1000, 8, 150, false, "ai_unavailable"]);
    assert.ok(!fs.existsSync(root), "nothing is written before a command or a tick");
    assert.strictEqual(desk.idle(), true);
    assert.strictEqual(await desk.tick(), true);
    assert.strictEqual(w.log.length, 0, "a stopped desk with nothing open stays off the network");

    desk.start({});
    assert.strictEqual(desk.status().running, true);
    await desk.tick();
    s = desk.status();
    assert.strictEqual(s.lastError, null);
    assert.deepStrictEqual([s.openPositions, s.trades, s.cash, s.equity, s.exposure, s.universe.events], [3, 3, 907, 1000, 93, 1]);
    const trade = s.journal.find((r) => r.kind === "trade");
    assert.deepStrictEqual([trade.agentId, trade.type, trade.legs, trade.shares, trade.costUsd, trade.group, trade.binding], ["a1", "arb_bundle", 3, 100, 93, "g1", "trade"]);
    assert.ok(/^3 legs × 100 sh: cost \$93\.00 \(fees \$0\.00\), guaranteed payout \$100\.00 → \+\$7\.00/.test(trade.why), trade.why);
    assert.strictEqual(s.candidates[0].verdict, "traded");
    assert.deepStrictEqual(s.positions.map((p) => [p.agentId, p.group, p.outcome, p.shares]).sort(), [["a1", "g1", "Yes", 100], ["a1", "g1", "Yes", 100], ["a1", "g1", "Yes", 100]]);
    assert.strictEqual(s.agents.find((a) => a.id === "a1").trades, 1);
    assert.ok(events.some((e) => e.type === "agents" && e.payload.openPositions === 3));
    assert.strictEqual(fs.statSync(path.join(root, "desk.json")).mode & 0o777, 0o600);
    const ring = desk.ring();
    assert.deepStrictEqual([ring.open, ring.events.length, ring.events[0].slug, ring.events[0].n, ring.events[0].agents, ring.events[0].cost], [3, 1, "who-wins", 3, ["a1"], 93]);

    setBooks(w, 0.3, 0.34);   // the arbitrage is gone from the books (Gamma's quotes still show it)
    clock.t += 6 * MIN;
    await desk.tick();
    s = desk.status();
    assert.deepStrictEqual([s.openPositions, s.trades, s.equity], [3, 3, 1003], "marked at the mid of 0.30/0.34");
    assert.strictEqual(s.candidates[0].verdict, "skipped");
    assert.ok(/margin is < 0\.5%/.test(s.candidates[0].why), s.candidates[0].why);
    assert.ok(w.log.some((u) => u.startsWith(`${GAMMA}/markets?`) && u.includes("closed=true")), "open positions are checked for a result");

    w.resolved = [0, 1, 2].map((i) => ({ conditionId: cid(`b${i}`), closed: true, outcomePrices: JSON.stringify(i === 0 ? ["1", "0"] : ["0", "1"]), umaResolutionStatus: "proposed" }));
    clock.t += 11 * MIN;
    await desk.tick();
    assert.strictEqual(desk.status().openPositions, 3, "a proposed result is not final");
    for (const r of w.resolved) r.umaResolutionStatus = "resolved";
    clock.t += 11 * MIN;
    await desk.tick();
    s = desk.status();
    assert.deepStrictEqual([s.openPositions, s.cash, s.equity, s.pnl, s.settled], [0, 1007, 1007, 7, 3]);
    const a1 = s.agents.find((a) => a.id === "a1");
    assert.deepStrictEqual([a1.realized, a1.settled, a1.wins, a1.open], [7, 3, 1, 0]);
    const report = desk.report({ period: "day" });
    assert.deepStrictEqual([report.totals.trades, report.totals.settled, report.totals.realized, report.closed.length, report.pnl], [1, 3, 7, 3, 7]);
    assert.strictEqual(desk.report({ period: "all" }).totals.trades, 1);
    assert.throws(() => desk.report({ period: "year" }), /agents_period_invalid/);

    assert.strictEqual(alerts.length, 0, "with a 60-minute digest nothing is sent per trade");
    clock.t = NOW + 61 * MIN;
    await desk.tick();
    const digest = alerts.find((a) => a.kind === "digest");
    assert.ok(digest && digest.rows.length === 4 && digest.count === 4 && digest.summary.equity === 1007, JSON.stringify(digest));
    clock.t = Date.UTC(2026, 10, 5, 6, 5);
    await desk.tick();
    const daily = alerts.find((a) => a.kind === "daily");
    assert.ok(daily && daily.report.totals.trades === 1 && daily.report.totals.realized === 7, JSON.stringify(daily));

    desk.dispose();
    assert.throws(() => desk.start({}), /agents_disposed/);
    assert.strictEqual(await desk.tick(), false);
    const again = makeDesk(w, { clock, root }).desk;
    s = again.status();
    assert.deepStrictEqual([s.running, s.equity, s.settled, s.trades, s.error], [true, 1007, 3, 3, null]);
    assert.ok(s.journal.some((r) => r.kind === "settle") && s.journal.some((r) => r.kind === "start"));
    again.dispose();
  }

  // --- the stops: daily loss, the next UTC day, by hand, drawdown; Telegram clears only a manual stop ---------------
  {
    const clock = { t: NOW };
    const w = bundleWorld();
    const { desk, alerts } = makeDesk(w, { clock });
    desk.start({ by: "telegram" });
    await desk.tick();
    setBooks(w, 0.05, 0.95);   // marked at the bids: $15 for what cost $93
    clock.t += MIN;
    await desk.tick();
    let s = desk.status();
    assert.deepStrictEqual([s.halt && s.halt.reason, s.halt && s.halt.by, s.equity, s.dayPnl], ["daily_loss", "rules", 922, -78]);
    const halt = alerts.find((a) => a.kind === "halt");
    assert.deepStrictEqual([halt.halt.reason, halt.halt.equity, halt.halt.limit], ["daily_loss", 922, 950]);
    assert.throws(() => desk.start({}), /agents_halted/);
    assert.throws(() => desk.resume({ by: "telegram" }), /agents_halt_desktop_only/);

    clock.t = Date.UTC(2026, 10, 5, 0, 1);
    await desk.tick();
    s = desk.status();
    assert.deepStrictEqual([s.halt, s.running, s.dayPnl], [null, true, 0], "a daily-loss stop clears with the new UTC day");
    assert.ok(s.journal.some((r) => r.kind === "halt_clear" && r.by === "new_day"));

    s = desk.kill({ by: "telegram" });
    assert.deepStrictEqual([s.halt.reason, s.halt.by, s.running], ["manual", "telegram", false]);
    desk.kill({ by: "ui" });
    assert.strictEqual(alerts.filter((a) => a.kind === "halt").length, 2, "a second stop sends nothing");
    s = desk.resume({ by: "telegram" });
    assert.deepStrictEqual([s.halt, s.running], [null, true]);

    desk.configure({ dailyLossPct: 0.5 });
    setBooks(w, 0.01, 0.95);
    clock.t += MIN;
    await desk.tick();
    assert.strictEqual(desk.status().halt.reason, "daily_loss");
    s = desk.resume({});
    assert.deepStrictEqual([s.halt, s.dayPnl, s.equity], [null, 0, 910], "the app takes the current equity as the day's start");

    desk.configure({ drawdownPct: 5 });
    clock.t += MIN;
    await desk.tick();
    s = desk.status();
    assert.strictEqual(s.halt.reason, "drawdown");
    assert.strictEqual(desk.ring().halt, "drawdown");
    assert.throws(() => desk.resume({ by: "telegram" }), /agents_halt_desktop_only/);
    s = desk.resume({});
    assert.deepStrictEqual([s.halt, s.peakEquity, s.running], [null, 910, true]);
    desk.dispose();
  }

  // --- a damaged store is never written over; a confirmed reset moves it aside ------------------------------------
  {
    const clock = { t: NOW };
    const root = tmp();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "desk.json"), "{not json");
    const { desk } = makeDesk(world(), { clock, root });
    let s = desk.status();
    assert.deepStrictEqual([s.error, s.running], ["agents_store_corrupt", false]);
    assert.throws(() => desk.start({}), /agents_store_corrupt/);
    assert.throws(() => desk.configure({ minEdgePct: 3 }), /agents_store_corrupt/);
    assert.strictEqual(await desk.tick(), false);
    desk.setContext({ active: false });
    assert.strictEqual(fs.readFileSync(path.join(root, "desk.json"), "utf8"), "{not json");
    assert.throws(() => desk.reset({ capitalUsd: 500 }), /agents_confirmation_required/);
    s = desk.reset({ capitalUsd: 500, confirm: true });
    assert.deepStrictEqual([s.error, s.equity, s.config.capitalUsd, s.running], [null, 500, 500, false]);
    assert.ok(fs.readdirSync(root).some((f) => f.startsWith("desk.json.corrupt-")));
    assert.strictEqual(validateState(JSON.parse(fs.readFileSync(path.join(root, "desk.json"), "utf8"))).config.capitalUsd, 500);
    desk.dispose();

    const stored = JSON.parse(fs.readFileSync(path.join(root, "desk.json"), "utf8"));
    stored.config.mode = "live";   // a store can't switch the desk to live trading either
    fs.writeFileSync(path.join(root, "desk.json"), JSON.stringify(stored));
    const live = makeDesk(world(), { clock, root }).desk;
    assert.strictEqual(live.status().error, "agents_store_corrupt");
    live.dispose();
  }

  // --- configuration, the agents' switches, a reset ---------------------------------------------------------------
  {
    const clock = { t: NOW };
    const w = bundleWorld();
    const { desk } = makeDesk(w, { clock });
    assert.throws(() => desk.configure({ mode: "live" }), /agents_live_requires_certificate/);
    assert.throws(() => desk.configure({ perTradeUsd: 60 }), /agents_limits_order/);
    assert.throws(() => desk.configure({ refreshMin: 1 }), /agents_config_invalid/);
    let s = desk.configure({ capitalUsd: 2000, minEdgePct: 3 });
    assert.deepStrictEqual([s.config.capitalUsd, s.startCapital, s.equity, s.config.minEdgePct, s.agents[0].capital], [2000, 2000, 2000, 3, 300]);
    assert.deepStrictEqual(s.journal[0].changed.sort(), ["capitalUsd", "minEdgePct"]);

    s = desk.agent({ id: "a1", action: "pause" });
    assert.deepStrictEqual([s.agents[0].status, s.agents[0].note], ["paused", "manual"]);
    assert.throws(() => desk.agent({ id: "a1", action: "pause" }), /agents_agent_not_active/);
    assert.throws(() => desk.agent({ id: "a99", action: "pause" }), /agents_agent_not_found/);
    assert.throws(() => desk.agent({ id: "a2", action: "explode" }), /agents_action_invalid/);
    desk.start({});
    await desk.tick();
    assert.strictEqual(desk.status().openPositions, 0, "a paused agent does not trade");
    desk.agent({ id: "a1", action: "resume" });
    clock.t += MIN;
    await desk.tick();
    assert.strictEqual(desk.status().openPositions, 3);
    assert.throws(() => desk.configure({ capitalUsd: 3000 }), /agents_reset_required/);
    desk.configure({ capitalUsd: 2000 });
    s = desk.reset({ confirm: true });
    assert.deepStrictEqual([s.openPositions, s.trades, s.running, s.equity, s.agents[0].status], [0, 0, false, 2000, "active"]);
    desk.dispose();
  }

  // --- the sources fail: the desk keeps going and retries the catalog in two minutes ------------------------------
  {
    const clock = { t: NOW };
    const w = bundleWorld();
    w.down = /gamma-api/;
    const { desk } = makeDesk(w, { clock });
    desk.start({});
    await desk.tick();
    let s = desk.status();
    assert.deepStrictEqual([s.lastError, s.universe.events, s.openPositions, s.sources.gamma_top.code], [null, 0, 0, "agents_http_503"]);
    w.down = null;
    clock.t += MIN;
    await desk.tick();
    assert.strictEqual(desk.status().universe.events, 0);
    clock.t += 2 * MIN;
    w.down = /clob/;
    await desk.tick();
    s = desk.status();
    assert.deepStrictEqual([s.universe.events, s.openPositions, s.sources.gamma_top, s.sources.clob_books.code, s.candidates[0].why], [1, 0, undefined, "agents_http_503", "no book"]);
    desk.dispose();
  }

  // --- the language model: a near-resolution check and a forecast, each traded on the next tick -------------------
  {
    const clock = { t: NOW };
    const w = world();
    w.events = [
      { id: "e8", slug: "bill", title: "Will the bill pass?", description: "Resolves YES if the bill passes by Friday.", endDate: iso(NOW + 30 * 3600000), tags: [{ slug: "politics" }],
        markets: [market("r1", "Bill", { bid: 0.86, ask: 0.88, end: NOW + 30 * 3600000 })] },
      { id: "e9", slug: "rates", title: "Fed decision in December?", description: "Resolves YES on a cut.", endDate: iso(NOW + 10 * DAY), tags: [{ slug: "politics" }],
        markets: [market("f1", "Cut", { bid: 0.5, ask: 0.52, end: NOW + 10 * DAY })] },
    ];
    w.books.r1y = book("r1y", 0.86, 0.88, 1000);
    w.books.f1y = book("f1y", 0.5, 0.52, 1000);
    w.rss = "<rss><channel><item><title>The bill passed the Senate &amp; was signed</title><pubDate>Wed, 04 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>";
    const queries = [];
    const ai = {
      agentsAvailable: () => ({ ok: true }),
      async agentQuery(query) {
        queries.push(query);
        const body = query.system === SYSTEM.resolution
          ? { checks: [{ id: "r1", status: "decided_yes", evidence: 0, reason: "signed into law" }] }
          : { forecasts: [{ id: "f1", p: 0.8, confidence: "high", reason: "the Fed signalled a cut" }] };
        return { content: JSON.stringify(body), costUsd: 0.003, model: "test/model" };
      },
    };
    const { desk } = makeDesk(w, { clock, ai });
    assert.strictEqual(desk.status().ai.available, true);
    desk.start({});
    await desk.tick();
    assert.deepStrictEqual(queries.map((q) => q.system), [SYSTEM.resolution]);
    const asked = JSON.parse(queries[0].prompt).markets[0];
    assert.deepStrictEqual([asked.id, asked.headlines[0].title, asked.price], ["r1", "The bill passed the Senate & was signed", 0.87]);
    clock.t += MIN;
    await desk.tick();
    let s = desk.status();
    const check = s.positions.find((p) => p.agentId === "a6");
    assert.ok(check && check.outcome === "Yes", JSON.stringify(s.candidates));
    near(check.prob, 0.87 + 0.6 * (0.985 - 0.87), 1e-4);
    assert.deepStrictEqual(queries.map((q) => q.system), [SYSTEM.resolution, SYSTEM.forecast]);
    clock.t += MIN;
    await desk.tick();
    s = desk.status();
    const forecast = s.positions.find((p) => p.agentId === "a7");
    assert.ok(forecast && forecast.outcome === "Yes", JSON.stringify(s.candidates));
    near(forecast.prob, 0.51 + 0.45 * (0.8 - 0.51), 1e-4);
    assert.deepStrictEqual([s.ai.calls, s.ai.spentUsd, s.ai.forecasts, s.ai.checks, s.ai.errors], [2, 0.006, 1, 1, 0]);
    assert.ok(s.journal.some((r) => r.kind === "trade" && r.type === "forecast" && /^AI p=0\.80 \(high\)/.test(r.model)));
    s = desk.configure({ aiDailyUsd: 0.005 });
    assert.deepStrictEqual([s.ai.available, s.ai.reason], [false, "agents_ai_budget_used"]);
    s = desk.configure({ aiDailyUsd: 1, aiEnabled: false });
    assert.strictEqual(s.ai.reason, "agents_ai_off");
    desk.dispose();

    const failing = makeDesk(w, { clock: { t: NOW }, ai: { agentsAvailable: () => ({ ok: true }), agentQuery: async () => { throw offline("ai_request_too_expensive"); } } }).desk;
    failing.start({});
    await failing.tick();
    s = failing.status();
    assert.deepStrictEqual([s.ai.errors, s.ai.lastError, s.lastError], [1, "ai_request_too_expensive", null]);
    assert.ok(s.journal.some((r) => r.kind === "ai_error" && r.code === "ai_request_too_expensive"));
    const off = makeDesk(w, { clock: { t: NOW }, ai: { agentsAvailable: () => ({ ok: false, reason: "ai_agents_openrouter_only" }) } }).desk;
    assert.strictEqual(off.status().ai.reason, "ai_agents_openrouter_only");
    failing.dispose();
    off.dispose();
  }

  // --- one match is one bet: at most three markets of it per agent; a weather model far from the fresh mid ---------
  {
    const clock = { t: NOW };
    const { desk } = makeDesk(world(), { clock });
    const say = (ru, en) => en;
    const fav = { id: "a3", params: {} };
    const ev = (id, match) => ({ id, slug: id, title: `Event ${id}`, sector: "sports", match });
    const mk = (id) => ({ id, conditionId: cid(id), yes: `${id}y`, no: `${id}n`, outcomes: ["Yes", "No"], label: id, endDate: iso(NOW + DAY), bid: 0.5, ask: 0.52 });
    const fill = { shares: 10, cost: 5, fees: 0, avg: 0.5 };
    const hold = (e, m, side = "yes") => desk.book.open({ agentId: "a3", type: "favorites", src: "x", event: ev(e, "game:7"), market: mk(m), side, fill, now: NOW });
    hold("g1", "m1");
    hold("g1", "m1", "no");   // both sides of one market are still one market
    hold("g1", "m2");
    const books = new Map();
    const c = { type: "favorites", event: ev("g2", "game:7"), market: mk("m4"), side: "yes" };
    assert.strictEqual(desk._precheck(c, fav, books, say), null, "two markets held: a third is allowed");
    hold("g2", "m3");   // the same match under Polymarket's second event
    assert.strictEqual(desk._precheck(c, fav, books, say), "the agent already holds 3 markets of this match");
    assert.strictEqual(desk._precheck({ ...c, market: mk("m1") }, fav, books, say), null, "adding to a market already held is no new market");
    assert.strictEqual(desk._precheck({ ...c, event: ev("g3", "game:8") }, fav, books, say), null, "another match");
    assert.strictEqual(desk._precheck(c, { id: "a4", params: {} }, books, say), null, "the cap is per agent");

    const wc = { type: "weather", event: ev("w1", "ev:w1"), market: mk("t1"), side: "yes", shrink: { p: 0.9, w: 0.4, maxGap: 0.25 } };
    books.set("t1y", { bids: [[0.6, 100]], asks: [[0.62, 100]] });
    assert.strictEqual(desk._precheck(wc, fav, books, say), "model 90% vs the market 61%: a gap over 25% is likelier a model error");
    books.set("t1y", { bids: [[0.7, 100]], asks: [[0.72, 100]] });
    assert.strictEqual(desk._precheck(wc, fav, books, say), null);
    books.delete("t1y");   // no fresh book: Gamma's quotes (0.50/0.52) decide
    assert.ok(/vs the market 51%/.test(desk._precheck(wc, fav, books, say)));
    assert.strictEqual(desk._precheck({ ...wc, shrink: null }, fav, books, say), null, "a decided bucket is exempt");
    desk.dispose();
  }

  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  console.log("agents desk tests ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
