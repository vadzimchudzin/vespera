"use strict";

/**
 * Through the server, a refusal raised before any external effect reaches the client with its real code and
 * closes the request. Anything unclassified keeps failing closed as "command_outcome_unknown".
 */

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("../main/executionHost");
const { ExecutionRouter } = require("../main/executionRouter");
const { RemoteClient } = require("../main/remoteClient");
const { createService } = require("./service");

const TOKEN = "refusal-test-token-" + "x".repeat(40);
const roots = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-refusals-")); roots.push(value); return value; }
function engineOptions() {
  return { market: { bars: [], on() {}, start() {}, stop() {}, async loadHistory() {} }, live: { configure() {}, async getQuote() { return null; } } };
}

async function run() {
  let service;
  let router;
  try {
    service = createService({ userDataDir: dir(), token: TOKEN, hostFactory: (options) => new ExecutionHost({ ...options, engineOptions: engineOptions() }) });
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${service.server.address().port}`;
    const deskRoot = dir();
    router = new ExecutionRouter({ userDataDir: deskRoot, host: new ExecutionHost({ userDataDir: deskRoot, engineOptions: engineOptions() }), pollMs: 100000 });
    await router.configure({ url, token: TOKEN });
    assert.equal((await router.switchMode("server")).ok, true);
    const client = new RemoteClient({ url, token: TOKEN });
    const device = router.connection.value.deviceId;
    const command = (requestId, method, args = []) => client.request("/v1/command", { deviceId: device, requestId, method, args });
    const code = (expected) => (err) => err.code === expected;

    // definite refusals keep their real code
    await assert.rejects(command("r1", "aiRecommend", [{ id: "x" }]), code("ai_disabled"));
    await assert.rejects(command("r2", "aiConfigure", [{ provider: "local", enabled: true }]), code("ai_local_desktop_only"), "a server can never use the desktop-only local model");
    await assert.rejects(router.dispatch("aiRecommend", [{ id: "x" }]), code("ai_disabled"), "the desktop client sees the same reason as a local run");

    // a closed request cannot be replayed
    await assert.rejects(command("r1", "aiRecommend", [{ id: "x" }]), code("request_already_completed"));
    // and the next request is not blocked by an earlier refusal
    const status = await command("r3", "aiStatus");
    assert.equal(status.config.enabled, false);

    // replace the host call to inject errors a real run could raise
    const original = service.host.call.bind(service.host);
    service.host.call = async (method, args) => {
      if (method === "start") throw Object.assign(new Error("venue exploded"), { code: "venue_exploded" });
      if (method === "runBacktest") throw Object.assign(new Error("lab busy"), { code: "research_busy" });
      if (method === "saveSetup") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      if (method === "stop") throw new Error("no code at all");
      return original(method, args);
    };

    // unclassified errors on a money-capable method stay unknown, and stay pending
    await assert.rejects(command("u1", "start"), code("command_outcome_unknown"));
    await assert.rejects(command("u1", "start"), code("command_outcome_unknown"), "the pending request is never silently retried");
    await assert.rejects(command("u2", "stop"), code("command_outcome_unknown"), "an error without a code stays unknown");

    // virtual methods: any well-formed lower-case code is a definite refusal
    await assert.rejects(command("v1", "runBacktest", [{}]), code("research_busy"));
    await assert.rejects(command("v1", "runBacktest", [{}]), code("request_already_completed"));
    // but a system error (not a well-formed code) is still unknown even there
    await assert.rejects(command("v2", "saveSetup", [{ name: "x" }]), code("command_outcome_unknown"));

    // the service stays healthy and keeps the owner
    assert.equal(service.owner.owner, "server");
    console.log("server refusal classification tests ok");
  } finally {
    router?.dispose();
    await service?.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
