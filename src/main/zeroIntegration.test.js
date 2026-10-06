"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("./executionHost");
const { ExecutionRouter } = require("./executionRouter");
const { RemoteClient } = require("./remoteClient");
const { createService } = require("../server/service");

const roots = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-zero-")); roots.push(value); return value; }
function engineOptions() {
  return {
    market: { bars: [], on() {}, start() {}, stop() {} },
    live: { configure() {}, async getQuote() { return null; } },
  };
}
const TOKEN = "isolated-integration-token-" + "x".repeat(40);

async function run() {
  const serverRoot = dir();
  const desktopRoot = dir();
  let service;
  let router;
  const factory = (options) => new ExecutionHost({ ...options, engineOptions: engineOptions() });
  try {
    service = createService({ userDataDir: serverRoot, token: TOKEN, hostFactory: factory });
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${service.server.address().port}`;
    const desktop = new ExecutionHost({ userDataDir: desktopRoot, engineOptions: engineOptions() });
    router = new ExecutionRouter({ userDataDir: desktopRoot, host: desktop, pollMs: 100000 });
    await router.configure({ url, token: TOKEN });
    await router.dispatch("saveSettings", [{ sizingMode: "fixed", fixedStakes: [5, 10, 20] }]);
    assert.strictEqual((await router.switchMode("server")).ok, true);
    assert.strictEqual(service.owner.owner, "server");
    assert.strictEqual(desktop.engine.running, false);
    await router.dispatch("saveSettings", [{ maxSeriesLossUsd: 40 }]);
    const remote = await router.dispatch("snapshot");
    assert.deepStrictEqual(remote.settings.fixedStakes, [5, 10, 20]);
    assert.strictEqual(remote.settings.maxSeriesLossUsd, 40);
    assert.strictEqual(service.host.engine.settings.proxyUrl, "");
    assert.strictEqual((await router.dispatch("start")).ok, true);
    assert.strictEqual(service.host.engine.running, true);
    router.dispose();
    assert.strictEqual(service.host.engine.running, true, "closing the desktop does not Stop the server");

    const reopenedDesktop = new ExecutionHost({ userDataDir: desktopRoot, engineOptions: engineOptions() });
    router = new ExecutionRouter({ userDataDir: desktopRoot, host: reopenedDesktop, pollMs: 100000 });
    assert.strictEqual(router.mode, "server");
    await router.dispatch("snapshot");
    assert.strictEqual(reopenedDesktop.engine.running, false, "desktop restart stays a UI client");
    await router.dispatch("stop");
    service.host.engine.paper.openBet = { side: "UP", sizeUsd: "5.00" };
    const refused = await router.switchMode("local");
    assert.strictEqual(refused.ok, false, "handoff is refused while a server position exists");
    assert.strictEqual(router.mode, "server", "a definite refusal leaves the UI on its confirmed server owner");
    assert.strictEqual(router.connection.value.transition, null, "known refusal is not left as an unknown handoff");
    assert.strictEqual(service.owner.owner, "server");
    service.host.engine.paper.openBet = null;
    assert.strictEqual((await router.switchMode("local")).ok, true);
    assert.strictEqual(service.owner.owner, "local");
    assert.strictEqual(service.host.engine.running, false);
    assert.strictEqual(reopenedDesktop.engine.risk.maxSeriesLossUsd, 40);
    assert.deepStrictEqual(reopenedDesktop.engine.risk.fixedStakes, [5, 10, 20]);
    assert.strictEqual((await router.dispatch("start")).ok, true);
    assert.strictEqual(reopenedDesktop.engine.running, true);
    const outsider = new RemoteClient({ url, token: TOKEN });
    const unauthorized = new RemoteClient({ url, token: "incorrect-token-" + "a".repeat(40) });
    await assert.rejects(unauthorized.request("/v1/status"), (err) => err.code === "remote_unauthorized");
    await assert.rejects(outsider.request("/v1/command", { deviceId: "other-pc", requestId: "other-start", method: "start", args: [] }));
    assert.strictEqual(service.host.engine.running, false, "server cannot execute while desktop owns it");
    await router.dispatch("stop");
    await service.close();
    service = null;
    await assert.rejects(router.dispatch("start"), (err) => err.code === "remote_unavailable", "startup cannot claim ownership from an unreachable server");
    assert.strictEqual(reopenedDesktop.engine.running, false);
    console.log("Zero Mode integration tests ok");
  } finally {
    router?.dispose();
    await service?.close();
  }
}
run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const value of roots) fs.rmSync(value, { recursive: true, force: true });
});
