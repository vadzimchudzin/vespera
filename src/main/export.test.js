"use strict";

/**
 * CSV export, per-day stats, reading rotated journals, and renderer
 * sanity (syntax + EN/RU key parity) so UI slips fail CI too.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Journal } = require("./journal");
const { toCsv, dailyBreakdown } = require("./stats");

// ── CSV ──────────────────────────────────────────────────────────────────────
{
  const { csv, count } = toCsv([
    { type: "setup" },
    { ts: "2026-09-23T10:00:00.000Z", type: "settled", side: "UP", sizeUsd: "2.50", entryPrice: 0.5, shares: 5, feeUsd: "0.09", outcome: "UP", status: "win", pnl: "2.41", slug: "btc-updown-15m-1" },
    { ts: "2026-09-23T10:15:00.000Z", type: "settled", mode: "auto", dryRun: true, side: "DOWN", sizeUsd: "5.00", status: "loss", pnl: "-5.18", orderId: 'a"b,c' },
  ]);
  assert.strictEqual(count, 2, "only settled bets");
  assert.ok(csv.startsWith("\ufeff"), "UTF-8 BOM for Excel");
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[0].startsWith("time,book,side,stake_usd,entry_price"));
  assert.ok(lines[1].includes(",paper,UP,2.50,0.5,5,0.09,"));
  assert.ok(lines[2].includes(",dry,DOWN,5.00,"), "books are labelled");
  assert.ok(lines[2].endsWith(',"a""b,c"'), "cells with quotes / commas are escaped");
  assert.strictEqual(toCsv([]).count, 0);
}

// ── per day ──────────────────────────────────────────────────────────────────
{
  const at = (d, h) => new Date(2026, 8, d, h).toISOString();
  const rows = dailyBreakdown(
    [
      { ts: at(22, 10), type: "settled", status: "win", pnl: "1.00", feeUsd: "0.04" },
      { ts: at(23, 9), type: "settled", status: "loss", pnl: "-1.04", feeUsd: "0.04" },
      { ts: at(23, 11), type: "settled", status: "win", pnl: "2.00", feeUsd: "0.07" },
      { ts: at(23, 12), type: "settled", mode: "auto", status: "win", pnl: "50" },
    ],
    "paper"
  );
  assert.deepStrictEqual(rows.map((r) => r.day), ["2026-09-23", "2026-09-22"], "newest first, local days");
  assert.deepStrictEqual([rows[0].bets, rows[0].wins, rows[0].pnl, rows[0].fees, rows[0].winRate], [2, 1, 0.96, 0.11, 0.5]);
}

// ── rotated journal is read in full, oldest first ────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsp-export-"));
  const j = new Journal(path.join(dir, "journal.jsonl"), { maxBytes: 300, maxFiles: 3, maxMemoryEntries: 2 });
  for (let i = 0; i < 8; i += 1) j.write({ type: "settled", n: i, pnl: "1.00", padding: "x".repeat(40) });
  assert.ok(fs.existsSync(path.join(dir, "journal.jsonl.1")), "rotation happened");
  assert.strictEqual(j.entries.length, 2, "memory keeps only the tail");
  const all = j.readAll().map((e) => e.n);
  assert.ok(all.length > 2, "export sees rotated files too");
  assert.deepStrictEqual(all, [...all].sort((a, b) => a - b), "oldest first");
  assert.strictEqual(all[all.length - 1], 7);
}

// ── renderer sanity ──────────────────────────────────────────────────────────
{
  const dir = path.join(__dirname, "..", "renderer");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    new vm.Script(fs.readFileSync(path.join(dir, file), "utf8"), { filename: file }); // throws on a syntax error
  }
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(dir, "i18n.js"), "utf8"), sandbox);
  const { en, ru } = sandbox.window.VSP_I18N;
  const missingRu = Object.keys(en).filter((k) => !(k in ru));
  const missingEn = Object.keys(ru).filter((k) => !(k in en));
  assert.deepStrictEqual([missingRu, missingEn], [[], []], "EN and RU have the same keys");
  // every t("key") used by the app exists
  const app = fs.readFileSync(path.join(dir, "app.js"), "utf8");
  const used = [...app.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((k) => !(k in en));
  assert.deepStrictEqual(unknown, [], `unknown i18n keys: ${unknown.join(", ")}`);

  const start = app.indexOf("  function updateSettingsLockUi(snap) {");
  const end = app.indexOf("  function queueDebouncedSettings(", start);
  assert.ok(start >= 0 && end > start);
  const fields = {
    base: { disabled: true, value: "1.00" },
    steps: { disabled: true, value: "6" },
    fixedStakes: { value: "5, 10, 20" },
  };
  const context = {
    $: (id) => fields[id] || null,
    canStartNewSeries: () => false,
    executionUnavailable: () => false,
    snap: { settings: { sizingMode: "fixed", baseUsd: "5.00", maxSteps: 3 } },
  };
  vm.runInNewContext(`${app.slice(start, end)}\nupdateSettingsLockUi(snap);`, context);
  assert.deepStrictEqual([fields.base.value, fields.steps.value], ["5.00", 3], "disabled ladder-derived fields follow accepted settings");
  assert.strictEqual(fields.fixedStakes.value, "5, 10, 20", "accepted snapshots do not overwrite the ladder draft");
  fields.base.disabled = false;
  fields.base.value = "8.00";
  vm.runInNewContext(`${app.slice(start, end)}\nupdateSettingsLockUi(snap);`, context);
  assert.strictEqual(fields.base.value, "8.00", "editable base draft is preserved");
}

console.log("export + renderer tests ok");

// A corrected historical close and a new execution source require a fresh series.
{
  let candles = [];
  let seeds = 0;
  const series = {
    setData(rows) {
      for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].time > rows[i - 1].time);
      candles = rows;
      seeds += 1;
    },
    update(row) {
      if (candles.length && row.time < candles.at(-1).time) throw new Error("Cannot update oldest data");
      candles.push(row);
    },
    applyOptions() {}, setMarkers() {},
    priceScale() { return { setVisibleRange() {}, applyOptions() {} }; },
  };
  const line = { setData() {}, applyOptions() {} };
  const timeScale = { subscribeVisibleLogicalRangeChange() {}, setVisibleRange() {}, scrollToRealTime() {} };
  const context = {
    window: {
      LightweightCharts: {
        ColorType: { Solid: "solid" }, CrosshairMode: { Normal: 0 },
        createChart() { return { addCandlestickSeries: () => series, addLineSeries: () => line, timeScale: () => timeScale, applyOptions() {} }; },
      },
      addEventListener() {},
    },
    document: { documentElement: { getAttribute: () => "glass-dark" }, getElementById: (id) => id === "chart" ? {} : null, querySelector: () => null },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Date, setTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/chart.js"), "utf8"), context);
  const bar = (time, close) => ({ time, open: 100, high: 102, low: 99, close });
  const state = { settings: { fastPeriod: 2, slowPeriod: 5, symbol: "BTCUSDT", timeframe: "15m" }, bars: [bar(100, 100), bar(200, 101)], forming: bar(300, 102), execution: { mode: "local" } };
  context.window.VesperaChart.render(state);
  context.window.VesperaChart.render({ ...state, bars: [bar(100, 100), bar(200, 100.5)] });
  assert.strictEqual(seeds, 2, "REST correction safely reseeds instead of updating an older candle");
  context.window.VesperaChart.render({ ...state, execution: { mode: "server" } });
  assert.strictEqual(seeds, 3, "switching cores resets the chart source");
  context.window.VesperaChart.render({ ...state, execution: { mode: "server" }, forming: bar(200, 102) });
  context.window.VesperaChart.reset();
  context.window.VesperaChart.render({ ...state, forming: bar(200, 102) });
  assert.strictEqual(candles.length, 2, "an already-closed forming candle is excluded");
}
