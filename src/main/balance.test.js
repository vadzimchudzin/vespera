"use strict";

// The balance a screen shows: Paper is the virtual book, Auto is the Polymarket wallet, and a virtual number is never
// shown as the wallet's. Covers the shared rules, the footer of the window and the first-paint placeholder.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { view } = require("../shared/balance");
const { Engine } = require("./engine");

const paper = { balance: "1005.13", openBet: null };
const live = (extra = {}) => ({ ok: true, value: "85.56", source: "live", pulsing: false, ...extra });
const auto = (liveBalance, extra = {}) => ({ mode: "auto", book: "live", settings: { dryRun: false }, paper, liveBalance, ...extra });

// ── the rules ────────────────────────────────────────────────────────────────
assert.deepEqual(view({ mode: "paper", book: "paper", paper, liveBalance: { ok: true, value: "1005.13", source: "paper" } }),
  { book: "paper", source: "paper", state: "ok", value: "1005.13", reason: null, at: null, virtual: null }, "Paper: the virtual book");

assert.deepEqual(view(auto(live({ at: 7 }))),
  { book: "live", source: "live", state: "ok", value: "85.56", reason: null, at: 7, virtual: null }, "Auto: the wallet");

// the bug: an engine that restarted in Auto carried the restored paper book in the wallet figure
for (const liveBalance of [{ ok: true, value: "1005.13", source: "paper", pulsing: false }, { ok: true, value: "1005.13" }, undefined, null]) {
  const shown = view(auto(liveBalance));
  assert.equal(shown.value, null, "a figure that was not read from the wallet is not shown");
  assert.equal(shown.state, "checking");
  assert.equal(shown.source, "live");
}

assert.equal(view(auto({ ok: false, value: "0.00", source: "live", pulsing: true, reason: "checking" })).state, "checking");
const failed = view(auto({ ok: false, value: "0.00", source: "live", pulsing: true, reason: "no_balance" }));
assert.deepEqual([failed.state, failed.value, failed.reason], ["unavailable", null, "no_balance"], "an unreadable wallet is unknown, not zero");
assert.equal(view(auto({ ok: false, value: "0.00", source: "live", pulsing: true })).reason, "no_balance");

const stale = view(auto(live({ stale: true, reason: "network: down", at: 5 })));
assert.deepEqual([stale.state, stale.value, stale.reason, stale.at], ["stale", "85.56", "network: down", 5], "the last real figure is kept and marked");

const dry = view({ mode: "auto", book: "dry", settings: { dryRun: true }, paper, liveBalance: live() });
assert.deepEqual([dry.book, dry.value, dry.virtual, dry.source], ["dry", "85.56", "1005.13", "live"], "a dry run shows the wallet and its virtual account apart");
assert.equal(view({ mode: "auto", settings: { dryRun: false }, paper, liveBalance: live() }).book, "live", "book follows dryRun when the snapshot has none");
assert.equal(view({ mode: "auto", settings: { dryRun: true }, paper, liveBalance: live() }).book, "dry");
assert.equal(view({ mode: "auto", settings: { dryRun: false }, paper, liveBalance: live() }).virtual, null, "real money has no virtual account");

for (const mode of ["paper", "auto"]) {
  const waiting = view({ mode, paper, liveBalance: live(), serverStateMissing: true });
  assert.deepEqual([waiting.state, waiting.value, waiting.reason], ["unavailable", null, "server_unreachable"], `Zero Mode, no server state yet (${mode})`);
}
assert.equal(view(undefined).state, "checking");
assert.equal(view({}).value, null);
assert.equal(view({ mode: "paper" }).value, null, "no paper book in the snapshot: unknown, not a number");

// ── the real engine feeds it correctly after a restart ───────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-balance-"));
  const market = { bars: [], on() {}, start() {}, stop() {} };
  const offline = { async ping() { return { ok: false }; }, async getBalance() { return null; }, configure() { return this; } };
  const first = new Engine({ userDataDir: dir, settings: { mode: "paper" }, live: offline, market });
  first.resetPaper("1005.13");
  first.dispose();
  const restarted = new Engine({ userDataDir: dir, settings: { mode: "auto", dryRun: false }, live: offline, market });
  const shown = view(restarted.snapshot());
  assert.equal(restarted.snapshot().paper.balance, "1005.13");
  assert.deepEqual([shown.state, shown.value], ["checking", null], "what a window would show right after the restart");
  restarted.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── the footer ───────────────────────────────────────────────────────────────
{
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const start = source.indexOf("  function paintBalance(snap) {");
  const end = source.indexOf("\n  function ", start + 1);
  assert.ok(start >= 0 && end > start, "paintBalance found");
  const el = { textContent: "", title: "", names: new Set() };
  el.classList = { add: (...names) => names.forEach((n) => el.names.add(n)), remove: (...names) => names.forEach((n) => el.names.delete(n)) };
  const context = { $: (id) => (id === "bal" ? el : null), t: (key) => `<${key}>`, money: (n) => Number(n).toFixed(2), window: { VesperaBalance: { view } } };
  vm.runInNewContext(source.slice(start, end), context);
  const paint = (snap) => { context.paintBalance(snap); return { text: el.textContent, title: el.title, classes: [...el.names].sort() }; };

  assert.deepEqual(paint({ mode: "paper", book: "paper", paper }), { text: "$1005.13", title: "", classes: [] });
  assert.deepEqual(paint(auto(live())), { text: "$85.56", title: "", classes: [] }, "Auto: the wallet, and the classes of the previous paint are gone");
  assert.deepEqual(paint(auto({ ok: true, value: "1005.13", source: "paper" })), { text: "—", title: "<checkingBalance>", classes: ["pulse"] },
    "the restored paper book is never painted as the wallet");
  assert.deepEqual(paint(auto({ ok: false, value: "0.00", source: "live", pulsing: true, reason: "no_balance" })),
    { text: "—", title: "<noBalance> (no_balance)", classes: ["bad", "pulse"] });
  assert.deepEqual(paint(auto(live({ stale: true, reason: "no_balance" }))), { text: "$85.56", title: "<staleBalance> (no_balance)", classes: ["stale"] });
  assert.deepEqual(paint({ mode: "auto", book: "dry", settings: { dryRun: true }, paper, liveBalance: live() }),
    { text: "$85.56", title: "<dryBalanceHint> $1005.13", classes: [] });
  assert.deepEqual(paint({ mode: "paper", paper, serverStateMissing: true }), { text: "—", title: "<noBalance> (server_unreachable)", classes: ["bad", "pulse"] },
    "Zero Mode before the server has answered: no figure");
}

// ── first paint ──────────────────────────────────────────────────────────────
{
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  const footer = /<strong id="bal"[^>]*>([^<]*)<\/strong>/.exec(html);
  assert.ok(footer, "footer balance element found");
  assert.ok(!/\d/.test(footer[1]), `the footer shows no number before the first snapshot (was: ${footer[1]})`);
  const shared = html.indexOf("../shared/balance.js");
  assert.ok(shared > 0 && shared < html.indexOf('src="app.js"'), "the shared rules are loaded before the app");
}

console.log("balance tests ok");
