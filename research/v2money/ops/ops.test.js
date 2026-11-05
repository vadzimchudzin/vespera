"use strict";
// Tests for the research operators: watchdog (checks and Telegram changes) and reconcile (matching, pages, rewards).
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const W = require("./watchdog");
const R = require("./reconcile");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "v2ops-"));
const jl = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };

async function main() {
  // --- watchdog
  assert.deepStrictEqual(W.parse(["--dir", "x", "--stale-min", "3"]), { dir: "x", collector: null, lanes: null, staleMin: 3, every: 0 });
  assert.throws(() => W.parse(["--bogus", "1"]), /invalid argument/);
  const now = Date.UTC(2026, 10, 5, 18, 0);
  {
    const d = tmp();
    let r = W.check({ dir: d, staleMin: 5 }, now);
    assert.strictEqual(r.ok, true, "nothing deployed is not an alert");
    assert.deepStrictEqual(r.items.latbot, { deployed: false });
    jl(path.join(d, "out", "status.jsonl"), [{ t: now - 600000, clobOpen: true }, { t: now - 30000, clobOpen: true, wins: 32, open: 5 }]);
    fs.appendFileSync(path.join(d, "out", "status.jsonl"), "{\"t\":12"); // a partial last line is skipped
    jl(path.join(d, "lpout", "minutes.jsonl"), [{ t: now - 20000, ok: 300, rtds: { open: true }, tot: { hs: { rP: 10, mtm: -2.5 } } }]);
    r = W.check({ dir: d, staleMin: 5 }, now);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.items.latbot.ageMin, 0.5);
    assert.deepStrictEqual(r.items.lp.netPess, { hs: 7.5 });
    jl(path.join(d, "out", "status.jsonl"), [{ t: now - 600000, clobOpen: false }]);
    jl(path.join(d, "lpout", "minutes.jsonl"), [{ t: now - 1000, ok: 300, rtds: { open: false }, tot: {} }]);
    fs.writeFileSync(path.join(d, "lpout", "pid"), "999999999");
    r = W.check({ dir: d, staleMin: 5 }, now);
    assert.deepStrictEqual(r.alerts.sort(), ["latbot_clob_closed", "latbot_stale", "lp_down", "lp_rtds_down"]);
    // collector and lanes
    fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ at: now - 1000, stopped: null, feeds: { clob: { last: now - 1000 }, binance: { last: now - 900000 } } }));
    fs.mkdirSync(path.join(d, "lanes"));
    fs.writeFileSync(path.join(d, "lanes", "lp.json"), "{}");
    fs.utimesSync(path.join(d, "lanes", "lp.json"), new Date(now - 3600000), new Date(now - 3600000));
    r = W.check({ dir: path.join(d, "none"), collector: d, lanes: path.join(d, "lanes"), staleMin: 5 }, now);
    assert.deepStrictEqual(r.alerts.sort(), ["collector_feed_stale:binance", "lane_stale:lp"]);
    assert.strictEqual(r.items.lane_latency.ageMin, null, "a lane file that does not exist yet is not an alert");
    // Telegram: only changes are sent
    const sent = [], env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }, o = { dir: d };
    const send = async (b) => { sent.push(b); };
    assert.match(await W.notify(o, { at: "a", alerts: ["lp_down"] }, env, send), /LP-симуляция остановилась/);
    assert.strictEqual(await W.notify(o, { at: "b", alerts: ["lp_down"] }, env, send), null, "the same alert is not repeated");
    const t = await W.notify(o, { at: "c", alerts: ["collector_feed_stale:binance"] }, env, send);
    assert.match(t, /поток binance молчит/); assert.match(t, /снова в порядке: LP-симуляция остановилась/);
    assert.strictEqual(sent.length, 2); assert.strictEqual(sent[0].chat_id, "1");
    assert.strictEqual(await W.notify(o, { at: "d", alerts: [] }, {}, send), null, "no token: nothing is sent");
    assert.strictEqual(sent.length, 2);
  }
  // --- reconcile: matching
  const j = R.normJournal([
    { token: "A", side: "buy", size: 10, price: 0.5, t: 1000000, tx: "0xAA" },
    { token_id: "A", side: "SELL", shares: 10, px: 0.55, at: 1100 },          // seconds
    { asset: "B", side: "BUY", size: 5, price: 0.3, timestamp: 1200000 },
    { token: "C", side: "HOLD", size: 1, price: 0.1, t: 1 },                  // dropped
  ]);
  assert.strictEqual(j.length, 3); assert.strictEqual(j[1].t, 1100000);
  const c = R.normChain([
    { token_id: "A", side: "BUY", size: "10", price: "0.51", timestamp: 1001, transaction_hash: "0xaa" },
    { token_id: "A", side: "SELL", size: 10.05, price: 0.553, timestamp: 1150 },
    { token_id: "B", side: "BUY", size: 5, price: 0.3, timestamp: 1500 },       // 300 s off: no match
    { token_id: "D", side: "BUY", size: 1, price: 0.9, timestamp: 1200 },
  ]);
  const m = R.match(j, c);
  assert.strictEqual(m.pairs.length, 2);
  assert.deepStrictEqual(m.onlyJournal.map((x) => x.token), ["B"]);
  assert.deepStrictEqual(m.onlyChain.map((x) => x.token).sort(), ["B", "D"]);
  // --- reconcile: run with a fake API (pages, flows by day, expectations, positions)
  const d = tmp(), jf = path.join(d, "j.jsonl"), ef = path.join(d, "e.json");
  jl(jf, [{ token: "A", side: "BUY", size: 10, price: 0.5, t: Date.UTC(2026, 10, 4, 12) }]);
  fs.writeFileSync(ef, JSON.stringify({ "2026-11-04": 5, "2026-11-05": 6 }));
  const urls = [];
  const get = async (url) => {
    urls.push(url);
    const u = new URL(url), ep = u.pathname.split("/").pop();
    if (ep === "trades" && !u.searchParams.get("cursor")) return { data: [{ token_id: "A", side: "BUY", size: 10, price: 0.505, timestamp: Date.UTC(2026, 10, 4, 12, 1) / 1000 }], pagination: { has_more: true, next_cursor: "k" } };
    if (ep === "trades") return { data: [], pagination: { has_more: false } };
    if (ep === "activity") return { data: [{ type: "REWARD", usdc_size: 4.5, timestamp: Date.UTC(2026, 10, 4, 23) / 1000 }, { type: "REWARD", usdc_size: 1, timestamp: Date.UTC(2026, 10, 4, 23, 5) / 1000 },
      { type: "MAKER_REBATE", usdc_size: 0.7, timestamp: Date.UTC(2026, 10, 5, 1) / 1000 }], pagination: { has_more: false } };
    if (ep === "positions") return { data: [{ token_id: "A", current_size: 10 }], pagination: { has_more: false } };
    throw new Error(`unexpected ${url}`);
  };
  const o = R.parse(["--wallet", "0x" + "1".repeat(40), "--journal", jf, "--expect", ef]);
  const r = await R.run(o, get);
  assert.deepStrictEqual(r.trades, { chain: 1, journal: 1, matched: 1, onlyJournal: 0, onlyChain: 0 });
  assert.strictEqual(r.slippageC, 0.5);
  assert.deepStrictEqual(r.rewards, [{ day: "2026-11-04", paid: 5.5, expected: 5 }, { day: "2026-11-05", paid: 0, expected: 6 }]);
  assert.deepStrictEqual(r.flows["2026-11-05"], { MAKER_REBATE: 0.7 });
  assert.strictEqual(r.positions.differ.length, 0); assert.strictEqual(r.ok, true);
  assert.ok(urls.some((u) => u.includes("taker_only=false")) && urls.some((u) => u.includes("cursor=k")));
  assert.match(R.text(r), /2026-11-04: \$5\.5 \/ \$5/);
  assert.throws(() => R.parse(["--wallet", "0x12"]), /required/);
  console.log("ops tests passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
