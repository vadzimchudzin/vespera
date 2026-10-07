"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExecutionHost } = require("./executionHost");
const { ExecutionRouter } = require("./executionRouter");
const { createService } = require("../server/service");

const roots = [];
function dir() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-setup-remote-")); roots.push(root); return root; }
function options() {
  return { market: { bars: [], on() {}, start() {}, stop() {}, async configure() {}, async loadHistory() {} }, live: { configure() {}, async getQuote() { return null; } } };
}
async function run() {
  const desktopRoot = dir();
  const host = new ExecutionHost({ userDataDir: desktopRoot, engineOptions: options() });
  let router = new ExecutionRouter({ userDataDir: desktopRoot, host, pollMs: 100000 });
  const token = "isolated-test-" + "a".repeat(40);
  const service = createService({ userDataDir: dir(), token, hostFactory: (input) => new ExecutionHost({ ...input, engineOptions: options() }) });
  try {
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    await router.configure({ url: `http://127.0.0.1:${service.server.address().port}`, token });
    const first = await router.dispatch("saveSetup", [{ name: "BTC hourly" }]);
    assert.equal(first.ok, true);
    await router.dispatch("saveSettings", [{ timeframe: "1h", fastPeriod: 25 }]);
    const second = await router.dispatch("saveSetup", [{ id: first.setup.id, name: "BTC hourly" }]);
    assert.equal(second.setup.version, 2);
    assert.equal((await router.switchMode("server")).ok, true);
    let library = await router.dispatch("listSetups");
    assert.equal(library.setups[0].versions.length, 2);
    assert.equal(library.activeSetup.version, 2);
    assert.equal((await router.dispatch("applySetup", [{ id: first.setup.id, version: 1 }])).ok, true);
    assert.equal(service.host.engine.settings.fastPeriod, 20);
    const third = await router.dispatch("saveSetup", [{ id: first.setup.id, name: "BTC hourly" }]);
    assert.equal(third.setup.version, 3);
    const exported = await router.dispatch("exportSetup", [{ id: first.setup.id, version: 2 }]);
    assert.ok(!exported.json.includes("privateKey") && !exported.json.includes(token));
    const imported = await router.dispatch("importSetup", [{ json: exported.json }]);
    assert.equal(imported.ok, true);
    assert.notEqual(imported.setup.id, first.setup.id);
    service.host.engine.running = true;
    const blocked = await router.dispatch("applySetup", [{ id: first.setup.id, version: 2 }]);
    assert.equal(blocked.ok, false);
    assert.equal(service.host.engine.settings.fastPeriod, 20);
    await router.dispatch("stop");
    assert.equal((await router.switchMode("local")).ok, true, "additional remote versions merge with the local immutable history");
    library = await router.dispatch("listSetups");
    assert.equal(library.setups.find((setup) => setup.id === first.setup.id).versions.length, 3);
    assert.equal(library.activeSetup.version, 3);
    assert.equal(host.engine.running, false);
    router.dispose();
    router = new ExecutionRouter({ userDataDir: desktopRoot, host: new ExecutionHost({ userDataDir: desktopRoot, engineOptions: options() }), pollMs: 100000 });
    library = await router.dispatch("listSetups");
    assert.equal(library.activeSetup.version, 3);
    assert.equal(library.setups.length, 2);
    assert.equal((await router.dispatch("snapshot")).activeSetup.modified, false);
    console.log("Setup HTTP routing, handoff and restart tests ok");
  } finally {
    router.dispose();
    await service.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
