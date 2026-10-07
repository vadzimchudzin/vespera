"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("./executionHost");
const { Engine } = require("./engine");

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "vespera-setup-host-")); }
function options() {
  return {
    market: { bars: [], on() {}, start() {}, stop() {}, async configure() {} },
    live: { configure() {}, async getQuote() { return null; } },
  };
}

async function run() {
  const marketEngine = new Engine({ userDataDir: dir(), settings: { mode: "auto", symbol: "BTCUSDT", timeframe: "1h" }, ...options() });
  try {
    await marketEngine.applySettings({ symbol: "DOGEUSDT" });
    assert.equal(marketEngine.settings.symbol, "BTCUSDT");
    assert.equal(marketEngine.settings.timeframe, "1h", "an unsupported symbol patch cannot partially change timeframe");
    await marketEngine.applySettings({ symbol: "DOGEUSDT", timeframe: "15m" });
    assert.equal(marketEngine.settings.symbol, "DOGEUSDT");
    await marketEngine.applySettings({ timeframe: "1h" });
    assert.equal(marketEngine.settings.timeframe, "15m", "DOGE keeps only verified short round intervals");
  } finally { marketEngine.dispose(); }

  const interruptedDir = dir();
  let interrupted = new ExecutionHost({ userDataDir: interruptedDir, engineOptions: options() });
  const interruptedV1 = await interrupted.call("saveSetup", [{ name: "Activation recovery" }]);
  await interrupted.call("saveSettings", [{ fastPeriod: 22 }]);
  await interrupted.call("saveSetup", [{ id: interruptedV1.setup.id, name: "Activation recovery" }]);
  await interrupted.call("applySetup", [{ id: interruptedV1.setup.id, version: 1 }]);
  interrupted.store.save(interrupted.setupStore.getVersion(interruptedV1.setup.id, 2).settings);
  fs.writeFileSync(path.join(interruptedDir, "setup-activation.json"), JSON.stringify({
    versionTag: 1, id: interruptedV1.setup.id, version: 2,
  }), { mode: 0o600 });
  interrupted.dispose();
  interrupted = new ExecutionHost({ userDataDir: interruptedDir, engineOptions: options() });
  try {
    assert.equal(interrupted.engine.settings.fastPeriod, 22, "startup completes settings persistence after interrupted activation");
    assert.equal(interrupted.setupStore.value.activeSetup.version, 2, "startup commits the matching active version before Engine starts");
    assert.equal(fs.existsSync(path.join(interruptedDir, "setup-activation.json")), false);
  } finally { interrupted.dispose(); }

  const rollbackDir = dir();
  let rollbackHost = new ExecutionHost({ userDataDir: rollbackDir, engineOptions: options() });
  const rollbackV1 = await rollbackHost.call("saveSetup", [{ name: "Failed rollback" }]);
  await rollbackHost.call("saveSettings", [{ fastPeriod: 22 }]);
  await rollbackHost.call("saveSetup", [{ id: rollbackV1.setup.id, name: "Failed rollback" }]);
  await rollbackHost.call("applySetup", [{ id: rollbackV1.setup.id, version: 1 }]);
  rollbackHost.setupStore.setActive = () => { throw new Error("simulated durable ref failure"); };
  const failedActivation = await rollbackHost.call("applySetup", [{ id: rollbackV1.setup.id, version: 2 }]);
  assert.equal(failedActivation.reason, "setup_activation_recovery_pending", "failed rollback leaves a recoverable intent");
  assert.equal((await rollbackHost.call("start")).reason, "setup_activation_recovery_pending", "execution stays locked until recovery");
  assert.equal((await rollbackHost.call("saveSettings", [{ baseUsd: "9.00" }])).reason, "setup_activation_recovery_pending");
  assert.throws(() => rollbackHost.exportBundle(), /execution_busy/, "an unresolved activation cannot be handed off");
  assert.equal((await rollbackHost.call("testOrder")).reason, "setup_activation_recovery_pending", "test orders stay locked until recovery");
  assert.equal(fs.existsSync(path.join(rollbackDir, "setup-activation.json")), true);
  rollbackHost.dispose();
  rollbackHost = new ExecutionHost({ userDataDir: rollbackDir, engineOptions: options() });
  try {
    assert.equal(rollbackHost.engine.settings.fastPeriod, 22);
    assert.equal(rollbackHost.setupStore.value.activeSetup.version, 2, "restart resolves the durable intent as a complete activation");
    assert.equal(fs.existsSync(path.join(rollbackDir, "setup-activation.json")), false);
  } finally { rollbackHost.dispose(); }

  const dynamicHost = new ExecutionHost({ userDataDir: dir(), engineOptions: options() });
  try {
    dynamicHost.engine.symbols.push({ id: "WIFUSDT", label: "WIF/USDT" });
    await dynamicHost.call("saveSettings", [{ symbol: "WIFUSDT" }]);
    const dynamic = await dynamicHost.call("saveSetup", [{ name: "Exchange-listed pair" }]);
    assert.equal(dynamic.setup.settings.symbol, "WIFUSDT");
    await dynamicHost.call("saveSettings", [{ symbol: "BTCUSDT" }]);
    assert.equal((await dynamicHost.call("applySetup", [{ id: dynamic.setup.id, version: 1 }])).ok, true);
    const imported = JSON.parse((await dynamicHost.call("exportSetup", [{ id: dynamic.setup.id, version: 1 }])).json);
    imported.settings.symbol = "UNLISTEDUSDT";
    const unavailable = await dynamicHost.call("importSetup", [{ json: JSON.stringify(imported) }]);
    assert.equal((await dynamicHost.call("applySetup", [{ id: unavailable.setup.id, version: 1 }])).reason, "unknown_symbol");
  } finally { dynamicHost.dispose(); }

  const userData = dir();
  const host = new ExecutionHost({ userDataDir: userData, engineOptions: options() });
  try {
    const first = await host.call("saveSetup", [{ name: "Paper four hour" }]);
    assert(first.ok);
    assert.equal(first.setup.marketTimeframe, "15m");
    const saved = await host.call("listSetups");
    assert.equal(saved.setups.length, 1);
    assert.equal(saved.activeSetup.id, first.setup.id, "saving captures and activates the current configuration");
    assert.equal(saved.activeSetup.modified, false);
    await host.call("saveSettings", [{ fastPeriod: 24 }]);
    const applied = await host.call("applySetup", [{ id: first.setup.id, version: 1 }]);
    assert.equal(applied.ok, true);
    assert.equal(host.engine.settings.fastPeriod, 20);
    assert.equal(applied.activeSetup.modified, false);

    await host.call("saveSettings", [{ fastPeriod: 22 }]);
    assert.equal(host.engine.activeSetupSnapshot().modified, true, "edits are attributed as modified, not silently original");
    const appended = await host.call("saveSetup", [{ id: first.setup.id, name: "Paper four hour" }]);
    assert.equal(appended.setup.version, 2);
    assert.equal(host.setupStore.getVersion(first.setup.id, 1).settings.fastPeriod, 20);
    const exported = await host.call("exportSetup", [{ id: first.setup.id, version: 1 }]);
    assert(!exported.json.includes("privateKey"));
    const imported = await host.call("importSetup", [{ json: exported.json }]);
    assert.notEqual(imported.setup.id, first.setup.id);
    const copied = await host.call("copySetup", [{ id: first.setup.id, version: 1, name: "Independent copy" }]);
    assert.notEqual(copied.setup.id, first.setup.id);

    const activate = await host.call("applySetup", [{ id: first.setup.id, version: 1 }]);
    assert.equal(activate.ok, true);
    const attribution = host.engine.setupAttribution();
    let emittedOrder = null;
    host.engine.on((event) => { if (event.type === "order") emittedOrder = event.payload; });
    const bar = { openTs: 1_800_000_000_000, closeTs: 1_800_000_899_999, close: 100 };
    const opened = await host.engine._executeSignal({ signal: "UP", reason: "test" }, bar);
    assert.equal(opened.setup.fingerprint, attribution.fingerprint);
    assert.equal(emittedOrder.setup.fingerprint, attribution.fingerprint);
    const order = host.engine.journal.restoreEntries.find((entry) => entry.type === "order_sent");
    assert.equal(order.setup.id, first.setup.id);
    assert.equal(order.setup.version, 1);
    assert.equal(order.setup.fingerprint, attribution.fingerprint);
    const restored = new Engine({ userDataDir: userData, ...options() });
    try {
      assert.equal(restored.paper.openBet.setup.fingerprint, attribution.fingerprint, "open Paper bet keeps setup attribution after restart");
    } finally { restored.dispose(); }
    const settlement = host.engine._settleIfOpen({ closeTs: bar.closeTs + 900_000, close: 99 });
    assert.equal(settlement.setup.fingerprint, attribution.fingerprint);
    const stats = host.engine.snapshot().stats;
    assert.equal(stats.setupVersions[0].id, first.setup.id);
    assert.equal(stats.setupVersions[0].version, 1);

    assert.equal((await host.call("applySetup", [{ id: first.setup.id, version: 2 }])).reason, "series_active",
      "applying risk settings never resets an existing series");
    const bundle = host.exportBundle();
    host.dispose();
    const target = new ExecutionHost({ userDataDir: dir(), engineOptions: options() });
    try {
      await target.importBundle(bundle);
      assert.equal(target.setupStore.listSetups().length, 3, "transfer carries the full setup library");
      assert.equal(target.engine.activeSetupSnapshot().version, 1);
      assert.equal(target.engine.journal.restoreEntries.find((entry) => entry.type === "settled").setup.id, first.setup.id);
    } finally { target.dispose(); }
  } finally {
    try { host.dispose(); } catch { /* host already disposed before transfer */ }
  }
}

run().then(() => console.log("setup integration tests ok"), (error) => { console.error(error); process.exitCode = 1; });
