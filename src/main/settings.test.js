"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { LIMITS, normalizeSettings, RISK_FIELDS } = require("../shared/settings");

function expectInvalid(field, callback) {
  assert.throws(callback, (error) => error.code === "invalid_settings" && error.field === field);
}

assert.deepStrictEqual(RISK_FIELDS, ["baseUsd", "maxSteps", "sizingMode", "fixedStakes", "maxStakeUsd", "maxSeriesLossUsd"]);
assert.strictEqual(LIMITS.baseUsd.min, 0.01);
const browserContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/settings.js"), "utf8"), browserContext);
assert.strictEqual(typeof browserContext.window.VesperaSettings.normalizeSettings, "function");

// Strict validation preserves output types and passes unknown credential fields through.
assert.deepStrictEqual(normalizeSettings({
  baseUsd: 12.3,
  maxStakeUsd: "2.50",
  maxSeriesLossUsd: 25,
  dryRun: false,
  apiKey: "keep-me",
}), {
  baseUsd: "12.30",
  maxStakeUsd: 2.5,
  maxSeriesLossUsd: 25,
  dryRun: false,
  apiKey: "keep-me",
});

for (const [field, value] of [
  ["baseUsd", 0], ["baseUsd", 1.001], ["baseUsd", true], ["maxSteps", 21], ["maxStakeUsd", -0.01],
  ["maxEntryPrice", 0.505], ["minOpeningAtr", 0.03], ["minCrossTicks", 2001],
  ["confirmCount", 1.5], ["fastPeriod", 1], ["slowPeriod", 501], ["refreshMs", 0],
  ["sizingMode", "unknown"], ["maType", "WMA"], ["dryRun", "false"],
  ["fixedStakes", "1,,2"], ["fixedStakes", [0, 2]], ["fixedStakes", Array(21).fill(1)],
]) {
  expectInvalid(field, () => normalizeSettings({ [field]: value }));
}

// Partial updates retain omitted values and add only required coupled keys.
assert.deepStrictEqual(normalizeSettings({ maxStakeUsd: 2 }, { baseUsd: "8.00", maxSteps: 4 }), { maxStakeUsd: 2 });
assert.deepStrictEqual(normalizeSettings({ fastPeriod: 50 }, { fastPeriod: 20, slowPeriod: 30 }), { fastPeriod: 50, slowPeriod: 51 });
assert.deepStrictEqual(normalizeSettings({ slowPeriod: 40 }, { fastPeriod: 40, slowPeriod: 200 }), { slowPeriod: 41 });
assert.deepStrictEqual(normalizeSettings({ fastPeriod: 200 }, { fastPeriod: 20, slowPeriod: 200 }), { fastPeriod: 200, slowPeriod: 201 });

// Fixed sizing owns its ladder, first stake, and step count regardless of price.
assert.deepStrictEqual(normalizeSettings({ sizingMode: "fixed" }), {
  sizingMode: "fixed", maxSteps: 6, baseUsd: "1.00",
});
assert.deepStrictEqual(normalizeSettings({ fixedStakes: "5; 10\n20", sizingMode: "fixed", baseUsd: "99.00", maxSteps: 1 }), {
  fixedStakes: [5, 10, 20], sizingMode: "fixed", baseUsd: "5.00", maxSteps: 3,
});
assert.deepStrictEqual(normalizeSettings({ maxSteps: 2 }, { sizingMode: "fixed", fixedStakes: [5, 10, 20] }), {
  maxSteps: 3, baseUsd: "5.00",
});

// Legacy values are clamped/defaulted, while valid existing values survive a partial patch.
assert.deepStrictEqual(normalizeSettings({ baseUsd: -4, maxSteps: 200, maxEntryPrice: 2, minOpeningAtr: 1.13 }, {}, { strict: false }), {
  baseUsd: "0.01", maxSteps: 20, maxEntryPrice: 1, minOpeningAtr: 1.15,
});
assert.deepStrictEqual(normalizeSettings({ maxStakeUsd: "bad", dryRun: "bad" }, { maxStakeUsd: 4, dryRun: false }, { strict: false }), {
  maxStakeUsd: 4, dryRun: false,
});
assert.deepStrictEqual(normalizeSettings({ fastPeriod: 200 }, { fastPeriod: 20, slowPeriod: 200 }, { strict: false }), {
  fastPeriod: 200, slowPeriod: 201,
});
assert.deepStrictEqual(normalizeSettings({ sizingMode: "fixed", fixedStakes: "legacy" }, {}, { strict: false }), {
  sizingMode: "fixed", fixedStakes: [1, 2, 4, 8, 16, 32], maxSteps: 6, baseUsd: "1.00",
});

console.log("settings normalization tests ok");
