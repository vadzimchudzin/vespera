"use strict";

// The V2 certificates on hand-made numbers: the statistics, a9's sums by window and by day, its kill switch and its
// one verdict, and a10's phases with the shield's paired test.

const assert = require("assert");
const V = require("./v2cert");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const HOUR = 3600000, DAY = 86400000;
const D0 = Date.UTC(2026, 10, 6);

// --- statistics ---------------------------------------------------------------------------------------------------
near(V.tTail(2, 10), 0.036694, 1e-6);
near(V.tTail(2.326348, 1e6), 0.01, 1e-5);
near(V.tTail(3, 3), 0.028834, 1e-6);
near(V.tTail(-1.5, 20), 0.925382, 1e-6);
assert.strictEqual(V.tTail(0, 5), 0.5);
assert.strictEqual(V.tTail(NaN, 5), null);
near(V.tFrom(4, 10, 30), 2.5 / Math.sqrt(((30 - 4 * 6.25) / 3) / 4));
assert.strictEqual(V.tFrom(2, 1, 1), null, "two clusters are too few");
assert.strictEqual(V.tFrom(5, 5, 5), null, "no spread, no t");

// --- a9: sums by window -------------------------------------------------------------------------------------------
{
  const c = new V.LatCert(null, D0);
  const end = D0 + 300000;
  // window 1: two Up trades, +2¢ and +4¢ a share; Up wins
  c.add({ slug: "w1", group: "btc 5m", shadow: false, t: D0 + 100000, end, up: true, shares: 50, entry: 0.5, fee0: 0.875, pnl: 1 });
  c.add({ slug: "w1", group: "btc 5m", shadow: false, t: D0 + 110000, end, up: true, shares: 50, entry: 0.52, fee0: 0.87, pnl: 2 });
  // window 2: one Down trade, −1¢; a shadow ETH trade in its own window
  c.add({ slug: "w2", group: "btc 5m", shadow: false, t: D0 + 400000, end: end + 300000, up: false, shares: 100, entry: 0.4, fee0: 1.68, pnl: -1 });
  c.add({ slug: "e1", group: "eth 5m", shadow: true, t: D0 + 100000, end, up: true, shares: 10, entry: 0.5, fee0: 0.175, pnl: 0.5 });
  let g = c.groups();
  assert.deepStrictEqual(g.map((x) => [x.key, x.role, x.shadow, x.trades, x.windows]), [["btc 5m", "primary", false, 3, 2], ["eth 5m", "control", true, 1, 1]]);
  near(g[0].exit, 2 / 200);
  assert.strictEqual(g[0].res, null, "no result yet");
  assert.deepStrictEqual(c.days["2026-11-06"], { n: 3, pnl: 2, up: 0 }, "the shadow stays out of the days");
  // results: due a minute after the end, then with a backoff
  assert.deepStrictEqual(c.due(end + 59000), []);
  assert.deepStrictEqual(c.due(end + 61000), ["w1", "e1"]);
  c.retry("e1", end + 61000);
  assert.deepStrictEqual(c.due(end + 62000), ["w1"]);
  assert.deepStrictEqual(c.due(end + 61000 + 60000), ["w1", "e1"]);
  c.outcome("w1", 1);
  // w1 folds; w2 is busy with an open position; e1 waits for its result
  c.fold(end + 61000 + 300000, new Set(["w2"]));
  assert.deepStrictEqual(Object.keys(c.w).sort(), ["e1", "w2"]);
  g = c.groups();
  near(g[0].res, (100 - 50 * 0.5 - 0.875 - 50 * 0.52 - 0.87) / 100, 1e-9);
  assert.deepStrictEqual([g[0].resWindows, g[0].windows, g[0].trades, g[0].pending, g[0].noResult], [1, 2, 3, 1, 0], "the pending window still counts for the exit");
  // a window that never gets a result folds without one after its tries
  for (let i = 0; i < 20; i += 1) c.retry("e1", end);
  assert.deepStrictEqual(c.due(end + 10 * DAY), ["w2"], "e1 is out of tries; w2 still waits for its result");
  c.fold(end + DAY);
  assert.deepStrictEqual(Object.keys(c.w), ["w2"], "e1 folds without a result, w2 keeps waiting");
  assert.strictEqual(c.groups().find((x) => x.key === "eth 5m").noResult, 1);
  // saved and read back
  const back = new V.LatCert(JSON.parse(JSON.stringify(c.toJSON())), D0 + 5 * DAY);
  assert.deepStrictEqual(back.groups(), c.groups());
  assert.strictEqual(back.since, D0);
  assert.deepStrictEqual(new V.LatCert({ g: { x: { n: "bad" } }, w: { y: { k: 1 } }, days: { d: {} } }, D0).toJSON().g, {}, "bad rows are dropped");
}

// --- a9: time with live feeds, by UTC day ---------------------------------------------------------------------------
{
  const c = new V.LatCert(null, D0);
  c.uptime(D0 + DAY - 30000, true);                 // the first sample only starts the clock
  c.uptime(D0 + DAY + 30000, true);                 // across midnight: 30 s each side
  assert.deepStrictEqual([c.days["2026-11-06"].up, c.days["2026-11-07"].up], [30000, 30000]);
  c.uptime(D0 + DAY + 60000, false);                // not live: nothing
  c.uptime(D0 + DAY + 3600000, true);               // a long gap counts at most 2 minutes
  assert.strictEqual(c.days["2026-11-07"].up, 30000 + 120000);
}

// --- a9: the kill switch, the verdict ----------------------------------------------------------------------------
{
  // 500 BTC 5m trades in 100 windows, losing: the kill switch fires once
  const c = new V.LatCert(null, D0);
  for (let w = 0; w < 100; w += 1) for (let i = 0; i < 5; i += 1) {
    c.add({ slug: `k${w}`, group: "btc 5m", shadow: false, t: D0 + w * 300000, end: D0 + (w + 1) * 300000, up: true, shares: 10, entry: 0.5, fee0: 0.175, pnl: i === 0 ? 0.2 : -0.1 });
  }
  let ev = c.evaluate(D0 + DAY);
  assert.deepStrictEqual(ev.map((e) => [e.op, e.trades]), [["v2_kill", 500]]);
  near(ev[0].exit, -0.2 / 50, 1e-9);
  assert.deepStrictEqual(c.evaluate(D0 + DAY), [], "once");
  const s = c.summary(D0 + DAY);
  assert.deepStrictEqual([s.verdict, s.kill.trades, s.checks.find((x) => x.id === "primary_trades").ok], ["kill", 500, false]);

  // a winner: 2000 BTC trades (1200 in 5m), three full days, every day positive and no day above half
  const p = new V.LatCert(null, D0);
  let n = 0;
  for (let d = 0; d < 3; d += 1) {
    for (let w = 0; w < 200; w += 1) {
      const t = D0 + d * DAY + w * 300000, k = w % 5 < 3 ? "btc 5m" : "btc 15m";
      for (let i = 0; i < 3 + (w % 2); i += 1) {
        if (n >= 2000) break;
        n += 1;
        p.add({ slug: `${k}-${d}-${w}`, group: k, shadow: k !== "btc 5m", t, end: t + 300000, up: i % 2 === 0, shares: 20, entry: 0.5, fee0: 0.35, pnl: 0.4 + (i === 2 ? -0.3 : 0.1 * (w % 3)) });
      }
    }
    p.uptime(D0 + d * DAY, true);
    for (let m = 1; m <= 21 * 30; m += 1) p.uptime(D0 + d * DAY + m * 120000, true);   // 21 h live
    p.upAt = null;
  }
  for (const w of Object.keys(p.w)) p.outcome(w, 1);
  const s1 = p.summary(D0 + 3 * DAY);
  assert.strictEqual(s1.verdict, "collecting");
  assert.deepStrictEqual(s1.checks.map((x) => [x.id, x.ok]), [["btc_trades", true], ["primary_trades", true], ["exit", true], ["resolution", true], ["day_share", true], ["positive_days", true]]);
  assert.strictEqual(s1.fullDays, 3);
  ev = p.evaluate(D0 + 3 * DAY);
  assert.deepStrictEqual(ev.map((e) => [e.op, e.verdict]), [["v2_verdict", "pass"]]);
  assert.deepStrictEqual([p.summary().verdict, p.summary().final.verdict, p.evaluate(D0 + 4 * DAY).length], ["pass", "pass", 0], "the verdict is taken once and stays");

  // a positive control is a warning about the simulator
  const q = new V.LatCert(null, D0);
  for (let w = 0; w < 120; w += 1) q.add({ slug: `e${w}`, group: "eth 5m", shadow: true, t: D0, end: D0 + 300000, up: true, shares: 10, entry: 0.5, fee0: 0.1, pnl: 0.3 + (w % 3) * 0.1 });
  assert.deepStrictEqual(q.summary().warnings.map((x) => [x.id, x.key]), [["control_positive", "eth 5m"]]);
}

// --- a10: phases and the shield -----------------------------------------------------------------------------------
{
  const nets = (k, f) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`c${i}`, f(i)]));
  // 10 markets, hs beats h in each by 1 ± a little: 12 h in
  let s = V.lpSummary({ upMs: 12 * HOUR, ph1: null, ph2: null, nets: nets(10, (i) => [2 + (i % 3) * 0.1, 1]), shocks: 6, pulledMs: 10, marketMs: 100, rewardsHs: 50, rewardsH: 55 });
  assert.deepStrictEqual([s.verdict, s.phase, s.phase1.done, s.phase1.hours, s.phase1.markets, s.phase2], ["collecting", 1, false, 12, 10, null]);
  assert.ok(s.shield.t > 2 && s.shield.helps && !s.shield.decided);
  assert.deepStrictEqual([s.perDay.shocks, s.pulledShare, s.rewardsGivenUp], [12, 0.1, 5]);
  assert.deepStrictEqual(s.phase1.checks.map((x) => [x.id, x.ok]), [["hours", false], ["net", true], ["top_market", true]]);
  // phase 1 done and passed, phase 2 running: what phase 2 made is the difference from the snapshot
  const p1 = nets(10, (i) => [2 + (i % 3) * 0.1, 1]);
  s = V.lpSummary({ upMs: 30 * HOUR, ph1: { t: 1, upMs: 24 * HOUR, nets: p1 }, ph2: null, nets: { ...nets(10, (i) => [3 + (i % 3) * 0.1, 1.5]), x: [1, 1] } });
  assert.deepStrictEqual([s.phase, s.phase1.done, s.phase2.hours, s.phase2.markets, s.phase2.net, s.shield.decided], [2, true, 6, 11, 11, true]);
  // one market makes most of phase 2: it fails, and so does the verdict
  const p2 = { ...nets(10, (i) => [3 + (i % 3) * 0.1, 1.5]), x: [40, 1] };
  s = V.lpSummary({ upMs: 49 * HOUR, ph1: { t: 1, upMs: 24 * HOUR, nets: p1 }, ph2: { t: 2, upMs: 48 * HOUR, nets: p2 }, nets: p2 });
  assert.deepStrictEqual([s.verdict, s.phase, s.phase2.done, s.phase2.checks.find((x) => x.id === "top_market").ok], ["fail", null, true, false]);
  // both phases positive and spread out: pass
  const p3 = nets(10, (i) => [3 + (i % 3) * 0.1, 1.5]);
  s = V.lpSummary({ upMs: 49 * HOUR, ph1: { t: 1, upMs: 24 * HOUR, nets: p1 }, ph2: { t: 2, upMs: 48 * HOUR, nets: p3 }, nets: p3 });
  assert.strictEqual(s.verdict, "pass");
  // a losing phase 1 fails at once
  s = V.lpSummary({ upMs: 25 * HOUR, ph1: { t: 1, upMs: 24 * HOUR, nets: nets(5, () => [-1, -2]) }, ph2: null, nets: nets(5, () => [-1, -2]) });
  assert.deepStrictEqual([s.verdict, s.phase1.topShare], ["fail", null]);
  assert.strictEqual(V.lpPhase({}).markets, 0);
}

console.log("agents v2 certificate tests ok");
