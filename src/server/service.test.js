"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { createService } = require("./service");
const { start } = require("./start");
const { ExecutionHost } = require("../main/executionHost");

const TOKEN = "unit-test-token-with-at-least-thirty-two-bytes";
const DEVICE = "desktop-a";
const tempDirs = [];

function fakeHost({ active = false, throwOn = null } = {}) {
  const host = {
    engine: { settings: { apiKey: "secret", privateKey: "private" } },
    running: false,
    active,
    calls: [],
    maxCalls: 0,
    currentCalls: 0,
    quiesceCalls: 0,
    exports: 0,
    imported: null,
    async call(method, args) {
      this.calls.push({ method, args });
      this.currentCalls += 1;
      this.maxCalls = Math.max(this.maxCalls, this.currentCalls);
      try {
        if (method === "testOrder") await new Promise((resolve) => setTimeout(resolve, 15));
        if (method === throwOn) throw new Error("transport lost");
        if (method === "start") this.running = true;
        if (method === "stop") this.running = false;
        if (method === "warmChart") return { mode: "paper", running: this.running };
        if (method === "snapshot") return { version: "test", running: this.running, status: this.running ? "watching" : "stopped", settings: { apiKey: "secret", proxyUrl: "http://private" } };
        return { ok: true, method };
      } finally { this.currentCalls -= 1; }
    },
    idle() { return !this.active; },
    async quiesce() {
      this.quiesceCalls += 1;
      if (this.active) { const error = new Error("position active"); error.code = "settings_locked"; throw error; }
      this.running = false;
      return true;
    },
    async exportBundle() { this.exports += 1; return { protocol: 1, settings: { theme: "glass-dark", apiKey: "bundle-secret-sentinel" }, history: ["portable"], checkpoint: { version: 1, entries: [] } }; },
    async importBundle(bundle) { this.imported = bundle; this.running = false; },
    async dispose() {
      if (this.running) {
        this.running = false;
        this.listener({ type: "status", payload: "stopped", state: { status: "stopped" } });
      }
    },
    emit(event) { this.listener(event); },
  };
  return host;
}

async function setup(options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-service-"));
  tempDirs.push(userDataDir);
  const hosts = [];
  const service = createService({
    userDataDir,
    token: TOKEN,
    now: options.now,
    hostFactory: ({ onEvent }) => {
      const host = fakeHost(options.hostOptions);
      host.listener = onEvent;
      hosts.push(host);
      return host;
    },
  });
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    service.server.once("listening", resolve);
    service.server.once("error", reject);
  });
  const address = service.server.address();
  const root = `http://127.0.0.1:${address.port}`;
  return { service, hosts, userDataDir, root };
}

async function request(root, url, { method = "GET", body, auth = true } = {}) {
  const response = await fetch(`${root}${url}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function activate(root, requestId = "activate-1") {
  const registration = await request(root, "/v1/register", { method: "POST", body: { deviceId: DEVICE, requestId: "register-device" } });
  assert.equal(registration.status, 200);
  return request(root, "/v1/activate", { method: "POST", body: { deviceId: DEVICE, requestId, bundle: { settings: {} } } });
}

after(async () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("HTTP auth, minimal health, and unknown methods are enforced", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  assert.throws(() => createService({ userDataDir: ctx.userDataDir, token: TOKEN, hostFactory: () => fakeHost() }), /service_already_running/);
  assert.deepEqual((await request(ctx.root, "/healthz", { auth: false })).body, { healthy: true, protocol: 1 });
  assert.equal((await request(ctx.root, "/v1/status", { auth: false })).status, 401);
  const initial = await request(ctx.root, "/v1/status");
  assert.deepEqual([initial.body.owner, initial.body.deviceId, initial.body.protocol], ["local", null, 1]);
  const registration = await request(ctx.root, "/v1/register", { method: "POST", body: { deviceId: DEVICE, requestId: "register-only" } });
  assert.equal(registration.body.owner, "local");
  assert.equal(ctx.hosts[0].imported, null);
  const foreign = await request(ctx.root, "/v1/register", { method: "POST", body: { deviceId: "foreign-device", requestId: "foreign-register" } });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.error, "device_already_registered");
  await activate(ctx.root);
  const result = await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "unknown", method: "deleteEverything" } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "method_not_allowed");
  assert.deepEqual(ctx.hosts[0].calls.map((call) => call.method), ["warmChart"]);
  const wrongOwner = await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: "foreign-device", requestId: "wrong-owner-command", method: "stop" } });
  assert.equal(wrongOwner.body.error, "owner_device_mismatch");
});

test("release refuses active positions and keeps server ownership", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  ctx.hosts[0].active = true;
  const result = await request(ctx.root, "/v1/release", { method: "POST", body: { deviceId: DEVICE, requestId: "release-active" } });
  assert.equal(result.status, 409);
  assert.equal(ctx.service.owner.owner, "server");
  assert.equal(ctx.hosts[0].quiesceCalls, 1);
  ctx.hosts[0].active = false;
  const retry = await request(ctx.root, "/v1/release", { method: "POST", body: { deviceId: DEVICE, requestId: "release-active" } });
  assert.equal(retry.status, 200);
});

test("release quiesces a running idle engine before transferring ownership", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "start-before-release", method: "start", args: [] } });
  assert.equal(ctx.hosts[0].running, true);
  const release = await request(ctx.root, "/v1/release", { method: "POST", body: { deviceId: DEVICE, requestId: "release-running" } });
  assert.equal(release.status, 200);
  assert.equal(ctx.hosts[0].running, false);
  assert.equal(ctx.service.owner.owner, "local");
});

test("release cache and its directory are fsynced before ownership moves local", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  const opened = new Map();
  const trace = [];
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  fs.openSync = function (file, ...args) {
    const fd = open.call(this, file, ...args);
    opened.set(fd, path.resolve(String(file)));
    return fd;
  };
  fs.fsyncSync = function (fd) {
    trace.push({ op: "fsync", path: opened.get(fd) });
    return sync.call(this, fd);
  };
  fs.renameSync = function (from, to) {
    trace.push({ op: "rename", path: path.resolve(String(to)) });
    return rename.call(this, from, to);
  };
  try {
    const release = await request(ctx.root, "/v1/release", { method: "POST", body: { deviceId: DEVICE, requestId: "durable-release" } });
    assert.equal(release.status, 200);
  } finally {
    fs.openSync = open;
    fs.fsyncSync = sync;
    fs.renameSync = rename;
  }
  const ownershipPath = path.join(ctx.userDataDir, "ownership.json");
  const cacheFile = path.join(ctx.userDataDir, "handoff-private", "settings.json");
  const ownershipCommit = trace.findIndex((row) => row.op === "rename" && row.path === ownershipPath);
  const cacheFileSync = trace.findIndex((row) => row.op === "fsync" && row.path === cacheFile);
  const cacheDirectorySync = trace.findIndex((row) => row.op === "fsync" && row.path === path.dirname(cacheFile));
  assert.ok(cacheFileSync >= 0 && cacheFileSync < ownershipCommit);
  assert.ok(cacheDirectorySync >= 0 && cacheDirectorySync < ownershipCommit);
});

test("release response is durably replayable; local ownership survives restart", async (t) => {
  const ctx = await setup();
  await activate(ctx.root);
  const first = await request(ctx.root, "/v1/release", { method: "POST", body: { deviceId: DEVICE, requestId: "release-lost-reply" } });
  assert.equal(first.status, 200);
  await ctx.service.close();

  const hosts = [];
  const service = createService({ userDataDir: ctx.userDataDir, token: TOKEN, hostFactory: ({ onEvent }) => {
    const host = fakeHost(); host.listener = onEvent; hosts.push(host); return host;
  } });
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { service.server.once("listening", resolve); service.server.once("error", reject); });
  t.after(() => service.close());
  const root = `http://127.0.0.1:${service.server.address().port}`;
  const replay = await request(root, "/v1/release", { method: "POST", body: { deviceId: DEVICE, requestId: "release-lost-reply" } });
  assert.deepEqual(replay.body.bundle, first.body.bundle);
  assert.equal(service.owner.owner, "local");
  assert.equal((await request(root, "/v1/snapshot")).body.state, null);
  assert.equal(hosts[0].exports, 0);
  assert.equal(hosts[0].calls.some((call) => call.method === "warmChart"), false);
  const encrypted = fs.readFileSync(path.join(ctx.userDataDir, "handoff-private", "settings.json"), "utf8");
  assert.equal(encrypted.includes("bundle-secret-sentinel"), false);
  assert.equal(encrypted.includes('"transferBundle"'), true);
});

test("mutating commands serialize and duplicate request ids never execute twice", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  const command = (requestId) => request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId, method: "testOrder", args: [] } });
  const [a, b] = await Promise.all([command("order-a"), command("order-b")]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body, { ok: true, method: "testOrder" });
  assert.equal(ctx.hosts[0].maxCalls, 1);
  assert.equal((await command("order-a")).body.error, "request_already_completed");
  assert.equal(ctx.hosts[0].calls.filter((call) => call.method === "testOrder").length, 2);
});

test("request tombstones remain durable beyond the old fixed ledger limit", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  for (let index = 0; index < 520; index += 1) {
    const reply = await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: `long-run-${index}`, method: "testOrder", args: [] } });
    assert.equal(reply.status, 200);
  }
  const replay = await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "long-run-0", method: "testOrder", args: [] } });
  assert.equal(replay.body.error, "request_already_completed");
  assert.equal(ctx.hosts[0].calls.filter((call) => call.method === "testOrder").length, 520);
});

test("an interrupted command remains unknown after process restart", async (t) => {
  const ctx = await setup({ hostOptions: { throwOn: "testOrder" } });
  await activate(ctx.root);
  const body = { deviceId: DEVICE, requestId: "uncertain-order", method: "testOrder", args: [] };
  assert.equal((await request(ctx.root, "/v1/command", { method: "POST", body })).status, 503);
  await ctx.service.close();

  const host = fakeHost();
  const service = createService({ userDataDir: ctx.userDataDir, token: TOKEN, hostFactory: ({ onEvent }) => { host.listener = onEvent; return host; } });
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { service.server.once("listening", resolve); service.server.once("error", reject); });
  t.after(() => service.close());
  const root = `http://127.0.0.1:${service.server.address().port}`;
  const replay = await request(root, "/v1/command", { method: "POST", body });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, "command_outcome_unknown");
  assert.deepEqual(host.calls.map((call) => call.method), ["warmChart"]);
});

test("events and snapshots redact credentials; proxy overrides are dropped", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "save-1", method: "saveSettings", args: [{ locale: "ru", proxyUrl: "http://should-not-apply" }] } });
  assert.deepEqual(ctx.hosts[0].calls.at(-1).args, [{ locale: "ru" }]);
  ctx.hosts[0].emit({ type: "settings", payload: { apiKey: "secret", ok: true, message: `private=private token=${TOKEN}` }, state: { settings: { privateKey: "private", locale: "ru" } } });
  const events = await request(ctx.root, "/v1/events?after=0");
  assert.equal(JSON.stringify(events.body).includes("secret"), false);
  assert.equal(JSON.stringify(events.body).includes("private"), false);
  const snapshot = await request(ctx.root, "/v1/snapshot");
  assert.equal(JSON.stringify(snapshot.body).includes("http://private"), false);
});

test("heartbeat expiry reports disconnection without stopping execution", async (t) => {
  let time = 1000;
  const ctx = await setup({ now: () => time });
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "start-1", method: "start", args: [] } });
  await request(ctx.root, "/v1/heartbeat", { method: "POST", body: { deviceId: DEVICE } });
  time += 31_000;
  const status = await request(ctx.root, "/v1/status");
  assert.equal(status.body.connected, false);
  assert.equal(status.body.desiredRunning, true);
  assert.equal(ctx.hosts[0].running, true);
  assert.equal(ctx.hosts[0].calls.filter((call) => call.method === "stop").length, 0);
});

test("venue-down pauses preserve restart intent; permanent stops clear it", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "start-events", method: "start", args: [] } });
  ctx.hosts[0].emit({ type: "status", payload: "paused", state: { status: "paused", pauseReason: "venue_down: temporary outage" } });
  assert.equal(ctx.service.owner.desiredRunning, true);
  ctx.hosts[0].emit({ type: "status", payload: "paused", state: { status: "paused", pauseReason: "geoblocked" } });
  assert.equal(ctx.service.owner.desiredRunning, false);
});

test("a prior explicit run resumes only after restart checks", async (t) => {
  const ctx = await setup();
  await activate(ctx.root);
  await request(ctx.root, "/v1/command", { method: "POST", body: { deviceId: DEVICE, requestId: "start-for-restart", method: "start", args: [] } });
  assert.equal(ctx.service.owner.desiredRunning, true);
  await ctx.service.close();
  const persistedOwner = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, "ownership.json"), "utf8"));
  assert.equal(persistedOwner.desiredRunning, true);

  const host = fakeHost();
  const service = createService({ userDataDir: ctx.userDataDir, token: TOKEN, hostFactory: ({ onEvent }) => { host.listener = onEvent; return host; } });
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { service.server.once("listening", resolve); service.server.once("error", reject); });
  t.after(() => service.close());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.calls[0].method, "warmChart");
  const resumed = host.calls.find((call) => call.method === "start");
  assert.ok(host.calls.findIndex((call) => call.method === "warmChart") < host.calls.findIndex((call) => call.method === "start"));
  assert.deepEqual(resumed.args, [{ confirmLive: true }]);
  assert.equal(service.owner.desiredRunning, true);
});

test("activation warms the server chart in background without starting execution", async (t) => {
  const ctx = await setup();
  t.after(() => ctx.service.close());
  await activate(ctx.root);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const warm = ctx.hosts[0].calls.find((call) => call.method === "warmChart");
  assert.ok(warm);
  assert.equal(ctx.hosts[0].calls.some((call) => call.method === "start"), false);
  assert.equal(ctx.hosts[0].running, false);
  assert.equal(ctx.service.owner.desiredRunning, false);
});

for (const crashPoint of ["pointer", "owner"]) test(`pending activation retries the identical bundle after a ${crashPoint}-commit crash`, async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-activate-crash-"));
  tempDirs.push(rootDir);
  const options = { market: { bars: [], on() {}, start() {}, stop() {} } };
  const source = new ExecutionHost({ userDataDir: path.join(rootDir, "desktop"), engineOptions: options });
  source.engine.paper.balance = require("../main/money").Decimal("765.43");
  source.engine.journal.write({ type: "settled", status: "loss", pnl: "-10.00", balanceAfter: "775.43" });
  source.engine.journal.write({ type: "settled", status: "loss", pnl: "-10.00", balanceAfter: "765.43" });
  source.engine.journal.write({ type: "activation_crash_sentinel", pnl: "-12.00" });
  const bundle = source.exportBundle();
  const serverDir = path.join(rootDir, "server");
  const host = new ExecutionHost({ userDataDir: serverDir, direct: true, engineOptions: options });
  const service = createService({ userDataDir: serverDir, token: TOKEN, host });
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { service.server.once("listening", resolve); service.server.once("error", reject); });
  const root = `http://127.0.0.1:${service.server.address().port}`;
  let serviceClosed = false;
  t.after(async () => { if (!serviceClosed) await service.close(); source.dispose(); });
  const registration = await request(root, "/v1/register", { method: "POST", body: { deviceId: DEVICE, requestId: "crash-register" } });
  assert.equal(registration.status, 200);

  const ownerPath = path.join(serverDir, "ownership.json");
  const failingPath = crashPoint === "pointer" ? path.join(serverDir, "execution-state.json") : ownerPath;
  const rename = fs.renameSync;
  let failOwnerCommit = true;
  fs.renameSync = function (from, to) {
    if (failOwnerCommit && to === failingPath) {
      failOwnerCommit = false;
      const error = new Error(`simulated ${crashPoint} commit crash`);
      error.code = "EIO";
      throw error;
    }
    return rename.call(this, from, to);
  };
  let interrupted;
  try {
    interrupted = await request(root, "/v1/activate", { method: "POST", body: { deviceId: DEVICE, requestId: "crash-activate", bundle } });
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(interrupted.status, crashPoint === "owner" ? 500 : 503);
  assert.equal(JSON.parse(fs.readFileSync(ownerPath, "utf8")).owner, "local");
  assert.equal(host.engine.paper.balance.toFixed(2), crashPoint === "owner" ? "765.43" : "1000.00");
  await service.close();
  serviceClosed = true;

  const restartedHost = new ExecutionHost({ userDataDir: serverDir, direct: true, engineOptions: options });
  const restarted = createService({ userDataDir: serverDir, token: TOKEN, host: restartedHost });
  restarted.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { restarted.server.once("listening", resolve); restarted.server.once("error", reject); });
  t.after(() => restarted.close());
  const restartedRoot = `http://127.0.0.1:${restarted.server.address().port}`;
  const mismatch = await request(restartedRoot, "/v1/activate", {
    method: "POST",
    body: { deviceId: DEVICE, requestId: "crash-activate", bundle: { ...bundle, settings: { ...bundle.settings, locale: "ru" } } },
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, "request_id_conflict");
  const retry = await request(restartedRoot, "/v1/activate", { method: "POST", body: { deviceId: DEVICE, requestId: "crash-activate", bundle } });
  assert.equal(retry.status, 200);
  assert.equal(restarted.owner.owner, "server");
  assert.equal(restartedHost.engine.paper.balance.toFixed(2), "765.43");
  assert.equal(restartedHost.engine.risk.step, 3);
  assert.equal(restartedHost.engine.journal.readAll().filter((row) => row.type === "activation_crash_sentinel").length, 1);
  assert.equal(restartedHost.engine.running, false);
  const changedAfterCommit = await request(restartedRoot, "/v1/activate", {
    method: "POST",
    body: { deviceId: DEVICE, requestId: "crash-activate", bundle: { ...bundle, settings: { ...bundle.settings, locale: "fr" } } },
  });
  assert.equal(changedAfterCommit.status, 409);
  assert.equal(changedAfterCommit.body.error, "request_id_conflict");
});

test("a server-owned idle restart warms charts without resuming execution", async (t) => {
  const ctx = await setup();
  await activate(ctx.root);
  await ctx.service.close();

  const host = fakeHost();
  const service = createService({ userDataDir: ctx.userDataDir, token: TOKEN, hostFactory: ({ onEvent }) => { host.listener = onEvent; return host; } });
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { service.server.once("listening", resolve); service.server.once("error", reject); });
  t.after(() => service.close());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.calls.filter((call) => call.method === "warmChart").length, 1);
  assert.equal(host.calls.some((call) => call.method === "start"), false);
  assert.equal(service.owner.desiredRunning, false);
});

test("corrupt ownership state fails closed", async (t) => {
  const ctx = await setup();
  await activate(ctx.root);
  await ctx.service.close();
  fs.writeFileSync(path.join(ctx.userDataDir, "ownership.json"), "not-json");
  assert.throws(() => createService({ userDataDir: ctx.userDataDir, token: TOKEN, hostFactory: () => fakeHost() }), /service_state_corrupt/);
});

test("service rejects bearer tokens with whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-invalid-token-"));
  tempDirs.push(dir);
  assert.throws(() => createService({ userDataDir: dir, token: `${TOKEN}\n`, hostFactory: () => fakeHost() }), /no whitespace/);
});

test("start() binds to configured address and constructs a real ExecutionHost from a token file", async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-start-smoke-"));
  tempDirs.push(userDataDir);
  const tokenFile = path.join(userDataDir, "server.token");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const service = start({
    VESPERA_DATA_DIR: userDataDir,
    VESPERA_SERVER_TOKEN_FILE: tokenFile,
    VESPERA_HOST: "127.0.0.1",
    VESPERA_PORT: "0",
  });
  t.after(() => service.close());
  await new Promise((resolve, reject) => {
    service.server.once("listening", resolve);
    service.server.once("error", reject);
  });
  assert.equal(typeof service.host.call, "function");
  assert.equal(service.host.engine.snapshot().mode, "paper");
  assert.equal(fs.existsSync(path.join(userDataDir, "settings.json")), true);

  const root = `http://127.0.0.1:${service.server.address().port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const registered = await fetch(`${root}/v1/register`, { method: "POST", headers, body: JSON.stringify({ deviceId: DEVICE, requestId: "start-register" }) });
  assert.equal(registered.status, 200);
  service.host.engineOptions.market = {
    bars: [],
    on() {},
    async loadHistory() {},
    start() {},
    stop() {},
  };
  const bundle = service.host.exportBundle();
  const activated = await fetch(`${root}/v1/activate`, { method: "POST", headers, body: JSON.stringify({ deviceId: DEVICE, requestId: "start-activate", bundle }) });
  assert.equal(activated.status, 200);
  const snapshotResponse = await fetch(`${root}/v1/snapshot`, { headers });
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.state.mode, "paper");
  assert.equal(snapshot.execution.owner, "server");
});
