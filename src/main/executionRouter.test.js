"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionRouter } = require("./executionRouter");
const { normalizeServerUrl } = require("./remoteClient");

const dirs = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-route-")); dirs.push(value); return value; }
function host() {
  const value = {
    calls: [], imported: 0, stops: 0,
    engine: { snapshot() { return { mode: "paper", running: false, settings: {}, bars: [] }; } },
    idle() { return true; },
    quiesce() { this.stops += 1; },
    dispose() { this.stops += 1; },
    exportBundle() { return { protocol: 1, settings: {}, history: [], checkpoint: { version: 1, entries: [] } }; },
    async importBundle() { this.imported += 1; },
    async call(method) { this.calls.push(method); return method === "start" ? { ok: true } : this.engine.snapshot(); },
  };
  return value;
}

async function run() {
  for (const url of ["http://example.com", "https://user:password@example.com", "https://example.com/?secret=a", "file:///tmp/a", "http://localhost:9000"]) {
    assert.throws(() => normalizeServerUrl(url), (err) => err.code === "invalid_server_url");
  }
  assert.strictEqual(normalizeServerUrl("https://example.com/"), "https://example.com");
  assert.strictEqual(normalizeServerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  const status = { protocol: 1, owner: "local", deviceId: null, version: "test" };
  let unavailable = false;
  let lostActivateReply = false;
  const commands = [];
  const clientFactory = () => ({ async request(route, body) {
    if (unavailable) { const e = new Error("offline"); e.code = "remote_unavailable"; throw e; }
    if (route === "/v1/status") return { ...status };
    if (route === "/v1/register") { status.deviceId = body.deviceId; return {}; }
    if (route === "/v1/activate") {
      status.owner = "server";
      status.deviceId = body.deviceId;
      if (lostActivateReply) { const e = new Error("lost reply"); e.code = "remote_unavailable"; throw e; }
      return {};
    }
    if (route === "/v1/release") { status.owner = "local"; return { bundle: {} }; }
    if (route === "/v1/snapshot") return { state: { running: true, settings: {}, bars: [] } };
    if (route.startsWith("/v1/events")) return { events: [], cursor: 0 };
    if (route === "/v1/heartbeat") return {};
    if (route === "/v1/command") { commands.push(body.method); return { ok: true }; }
    throw new Error(`unknown ${route}`);
  } });
  const root = dir();
  const local = host();
  const router = new ExecutionRouter({ userDataDir: root, host: local, clientFactory, pollMs: 100000 });
  await router.configure({ url: "http://127.0.0.1:8787", token: "test-" + "a".repeat(40) });
  assert.strictEqual((await router.switchMode("server")).ok, true);
  await router.dispatch("start");
  assert.deepStrictEqual(commands, ["start"]);
  assert.ok(!local.calls.includes("start"), "Zero Mode never starts the desktop core");
  unavailable = true;
  await router.poll();
  assert.strictEqual(router.execution().connected, false);
  assert.strictEqual(router.execution().blocked, true);
  await assert.rejects(router.dispatch("start"), (err) => err.code === "remote_unavailable");
  assert.ok(!local.calls.includes("start"), "offline does not fall back to local execution");
  unavailable = false;
  assert.strictEqual((await router.switchMode("local")).ok, true);
  assert.strictEqual(local.imported, 1);
  await router.dispatch("start");
  assert.ok(local.calls.includes("start"));
  lostActivateReply = true;
  assert.strictEqual((await router.switchMode("server")).reason, "handoff_pending");
  await assert.rejects(router.dispatch("start"), (err) => err.code === "handoff_pending");
  router.dispose();
  const afterCrash = new ExecutionRouter({ userDataDir: root, host: host(), clientFactory, pollMs: 100000 });
  await assert.rejects(afterCrash.dispatch("start"), (err) => err.code === "handoff_pending");
  lostActivateReply = false;
  assert.strictEqual((await afterCrash.switchMode("server")).ok, true, "same durable request resumes a lost handoff");
  assert.ok(!JSON.stringify(afterCrash.execution()).includes("test-"), "access token never enters renderer state");
  afterCrash.dispose();
  console.log("execution router tests ok");
}
run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
});
