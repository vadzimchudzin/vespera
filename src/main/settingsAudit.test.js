"use strict";

/**
 * Settings audit. Every setting the window exposes must
 *  1. be validated against the shared limits (edges accepted, outside and off-step values refused),
 *  2. reach the engine (snapshot, risk, strategy options, notifications, refresh rate),
 *  3. survive a restart through the real host and settings store,
 *  4. for strategy settings, change what the strategy actually signals on the same candles,
 *  5. be bound to the shared limits in the window code.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LIMITS, normalizeSettings } = require("../shared/settings");
const { Engine } = require("./engine");
const { ExecutionHost } = require("./executionHost");
const { evaluateBar } = require("./strategy");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vsp-audit-"));
const roots = [];
const dir = () => { const value = tmp(); roots.push(value); return value; };

function synthetic(count = 4200) {
  let seed = 123456789;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => { let sum = 0; for (let i = 0; i < 6; i += 1) sum += rnd(); return (sum - 3) / 0.7071; };
  const out = [];
  let price = 100;
  let drift = 0.02;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i += 1) {
    if (i % 300 === 0) drift = (rnd() - 0.5) * 0.12;
    const open = price;
    const close = open + drift + gauss() * 0.35;
    const high = Math.max(open, close) + rnd() * 0.25;
    const low = Math.min(open, close) - rnd() * 0.25;
    out.push({ openTs: t0 + i * 900000, closeTs: t0 + i * 900000 + 899999, open, high, low, close, volume: 1, closed: true });
    price = close;
  }
  return out;
}
const BARS = synthetic();

function fakeMarket() {
  return { bars: BARS.slice(), refresh: [], on() {}, start() {}, stop() {}, setRefreshMs(ms) { this.refresh.push(ms); } };
}
function stubLive() {
  return { async ping() { return { ok: true }; }, async getBalance() { return "100.00"; }, hasPrivateKey() { return false; }, configure() { return this; } };
}
const newEngine = () => new Engine({ userDataDir: dir(), settings: {}, live: stubLive(), market: fakeMarket() });
const expectInvalid = (field, input) => assert.throws(
  () => normalizeSettings(input, {}),
  (error) => error.code === "invalid_settings" && error.field === field,
  `${field} must refuse ${JSON.stringify(input)}`,
);

(async () => {
  // ── 1. validator: edges accepted, outside / off-step / garbage refused ─────
  for (const key of Object.keys(LIMITS).filter((name) => name !== "fixedStakes")) {
    const { min, max, step } = LIMITS[key];
    assert.doesNotThrow(() => normalizeSettings({ [key]: min }, {}), `${key} accepts its minimum`);
    assert.doesNotThrow(() => normalizeSettings({ [key]: max }, {}), `${key} accepts its maximum`);
    expectInvalid(key, { [key]: min - step });
    expectInvalid(key, { [key]: max + step });
    expectInvalid(key, { [key]: "abc" });
    expectInvalid(key, { [key]: "" });
    if (step >= 1) expectInvalid(key, { [key]: min + step / 2 });
  }
  for (const key of ["dryRun", "fullBodyOnS", "notificationsEnabled"]) {
    assert.strictEqual(normalizeSettings({ [key]: true }, {})[key], true);
    assert.strictEqual(normalizeSettings({ [key]: false }, {})[key], false);
    expectInvalid(key, { [key]: "true" });
    expectInvalid(key, { [key]: 1 });
  }
  for (const value of ["double", "fixed", "recover"]) assert.strictEqual(normalizeSettings({ sizingMode: value }, {}).sizingMode, value);
  expectInvalid("sizingMode", { sizingMode: "martingale" });
  for (const value of ["SMA", "EMA"]) assert.strictEqual(normalizeSettings({ maType: value }, {}).maType, value);
  expectInvalid("maType", { maType: "WMA" });
  assert.deepStrictEqual(normalizeSettings({ fixedStakes: [1, 2, 4] }, {}).fixedStakes, [1, 2, 4]);
  expectInvalid("fixedStakes", { fixedStakes: [] });
  expectInvalid("fixedStakes", { fixedStakes: Array(LIMITS.fixedStakes.maxLength + 1).fill(1) });
  expectInvalid("fixedStakes", { fixedStakes: [0] });
  expectInvalid("fixedStakes", { fixedStakes: [1.005] });
  // fast and slow average stay ordered whichever one is edited
  assert.ok(normalizeSettings({ fastPeriod: 200 }, {}).slowPeriod > 200);
  assert.ok(normalizeSettings({ slowPeriod: 5 }, {}).slowPeriod > 20);

  // ── 2. engine wiring: each setting reaches the engine ─────────────────────
  const SAMPLES = {
    baseUsd: "2.50", maxSteps: 4, maxStakeUsd: 25, maxSeriesLossUsd: 40, dailyLossLimitUsd: 50, maxEntryPrice: 0.8,
    minOpeningAtr: 0.5, minCrossTicks: 30, confirmCount: 2, fastPeriod: 10, slowPeriod: 150, refreshMs: 500,
    sizingMode: "recover", maType: "EMA", dryRun: false, fullBodyOnS: true, notificationsEnabled: false,
  };
  const reached = {
    baseUsd: (e) => e.risk.baseUsd.toFixed(2),
    maxSteps: (e) => e.risk.maxSteps,
    maxStakeUsd: (e) => e.risk.maxStakeUsd,
    maxSeriesLossUsd: (e) => e.risk.maxSeriesLossUsd,
    dailyLossLimitUsd: (e) => e.dailyLossLimit(),
    maxEntryPrice: (e) => e.snapshot().settings.maxEntryPrice,
    minOpeningAtr: (e) => e._evalOptions().minOpeningAtr,
    minCrossTicks: (e) => e._evalOptions().minCrossTicks,
    confirmCount: (e) => e._evalOptions().confirmCount,
    fastPeriod: (e) => e._evalOptions().fastPeriod,
    slowPeriod: (e) => e._evalOptions().slowPeriod,
    refreshMs: (e) => e.market.refresh.at(-1),
    sizingMode: (e) => e.risk.sizingMode,
    maType: (e) => e._evalOptions().maType,
    dryRun: (e) => e.isDryRun(),
    fullBodyOnS: (e) => e._evalOptions().fullBodyOnS,
    notificationsEnabled: (e) => e.notificationsEnabled,
  };
  for (const [key, value] of Object.entries(SAMPLES)) {
    const e = newEngine();
    await e.applySettings({ [key]: value });
    assert.strictEqual(e.snapshot().settings[key], value, `${key}: the snapshot shows the saved value`);
    assert.strictEqual(reached[key](e), value, `${key}: the engine uses the saved value`);
  }
  {
    const e = newEngine();
    await e.applySettings({ sizingMode: "fixed", fixedStakes: [2, 4, 8] });
    assert.deepStrictEqual(e.snapshot().settings.fixedStakes, [2, 4, 8]);
    assert.strictEqual(e.risk.maxSteps, 3, "ladder length sets the series length");
    assert.strictEqual(e.snapshot().settings.baseUsd, "2.00", "first stake sets the base");
    assert.strictEqual(e.risk.size(0.7).toFixed(2), "2.00", "the stake does not depend on the entry price");
  }

  // ── 3. persistence through a restart (real host and settings store) ───────
  const dataDir = dir();
  const hostOptions = () => ({ userDataDir: dataDir, engineOptions: { market: fakeMarket(), live: stubLive() } });
  const persisted = {
    sizingMode: "recover", baseUsd: "2.50", maxSteps: 4, maxStakeUsd: 25, maxSeriesLossUsd: 40, dailyLossLimitUsd: 50, maxEntryPrice: 0.8,
    minOpeningAtr: 0.5, minCrossTicks: 30, confirmCount: 2, fastPeriod: 10, slowPeriod: 150, maType: "EMA", fullBodyOnS: true,
    refreshMs: 500, notificationsEnabled: false, dryRun: false, theme: "glass-blue", locale: "ru",
  };
  {
    const host = new ExecutionHost(hostOptions());
    for (const group of [
      ["sizingMode", "baseUsd", "maxSteps", "maxStakeUsd", "maxSeriesLossUsd", "dailyLossLimitUsd", "maxEntryPrice"],
      ["minOpeningAtr", "minCrossTicks", "confirmCount", "fastPeriod", "slowPeriod", "maType", "fullBodyOnS"],
      ["refreshMs", "notificationsEnabled", "dryRun", "theme", "locale"],
    ]) await host.call("saveSettings", [Object.fromEntries(group.map((key) => [key, persisted[key]]))]);
    host.dispose();
  }
  {
    const host = new ExecutionHost(hostOptions());
    const snap = await host.call("snapshot");
    for (const [key, value] of Object.entries(persisted)) assert.strictEqual(snap.settings[key], value, `${key} survives a restart`);
    host.dispose();
  }
  {
    const fixedDir = dir();
    const options = () => ({ userDataDir: fixedDir, engineOptions: { market: fakeMarket(), live: stubLive() } });
    const host = new ExecutionHost(options());
    await host.call("saveSettings", [{ sizingMode: "fixed", fixedStakes: [2, 4, 8] }]);
    host.dispose();
    const again = new ExecutionHost(options());
    const snap = await again.call("snapshot");
    assert.deepStrictEqual(snap.settings.fixedStakes, [2, 4, 8], "the ladder survives a restart");
    assert.strictEqual(snap.settings.maxSteps, 3);
    again.dispose();
  }

  // ── 4. strategy settings change what the strategy signals ─────────────────
  const signalsFor = async (patch) => {
    const e = newEngine();
    if (Object.keys(patch).length) await e.applySettings(patch);
    const options = e._evalOptions();
    const out = [];
    for (let i = 250; i < BARS.length; i += 1) {
      const window = BARS.slice(Math.max(0, i - 319), i + 1);
      const ev = evaluateBar(window, window.length - 1, options);
      if (ev.signal) out.push(`${i}:${ev.signal}`);
    }
    return out;
  };
  const baseline = await signalsFor({});
  assert.ok(baseline.length >= 20, `the synthetic candles produce enough baseline signals (${baseline.length})`);
  const strategyVariants = {
    fastPeriod: 10, slowPeriod: 100, maType: "EMA", minOpeningAtr: 0.5, minCrossTicks: 40, confirmCount: 1, fullBodyOnS: true,
  };
  const effects = {};
  for (const [key, value] of Object.entries(strategyVariants)) {
    const changed = await signalsFor({ [key]: value });
    effects[key] = `${baseline.length} -> ${changed.length}`;
    assert.notDeepStrictEqual(changed, baseline, `${key}=${value} must change the signals on the same candles`);
  }
  console.log("strategy settings effect (signals on the same 4,200 candles):", JSON.stringify(effects));

  // ── 5. the window binds every setting to the shared limits ────────────────
  const app = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  for (const key of Object.keys(LIMITS).filter((name) => name !== "fixedStakes")) assert.ok(new RegExp(`limits\\.${key}\\b`).test(app), `the window binds ${key} to the shared limit`);
  // the stake ladder is a text field checked by the same shared validator before it is saved
  assert.ok(app.includes('id="fixedStakes"') && /VesperaSettings\.normalizeSettings\(/.test(app), "the window validates the ladder with the shared validator");
  for (const id of ["base", "steps", "maxStake", "maxEntry", "dailyLimit", "maxSeriesLoss", "opening", "crossTicks", "confirms", "fastPeriod", "slowPeriod", "refresh"]) {
    assert.ok(app.includes(`id="${id}"`), `the window has the control #${id}`);
  }

  console.log("settings audit tests ok");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
