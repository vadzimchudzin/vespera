"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { backup, restore, verifyBackup, preflight, monitorMetrics, readHealth } = require("./operations");
const { args: restoreArgs } = require("./operations-restore");
const { parse: monitorArgs } = require("./operations-monitor");

const roots = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vespera-operations-"));
  roots.push(dir);
  return dir;
}
function put(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode });
}
function setup() {
  const root = temp();
  const dataDir = path.join(root, "source-data");
  const tokenFile = path.join(root, "server.token");
  const destination = path.join(root, "backup");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  put(path.join(dataDir, "ownership.json"), '{"owner":"server","epoch":9,"desiredRunning":false}\n');
  put(path.join(dataDir, "request-ledger", "a1.json"), '{"id":"a1","state":"done","response":{"ok":true}}\n');
  put(path.join(dataDir, "telegram-private", "telegram-master.key"), crypto.randomBytes(32));
  put(path.join(dataDir, "handoff-private", "settings.json"), '{"transferBundle":"encrypted"}\n');
  put(path.join(dataDir, "book-abc", "journal.jsonl.state.json"), '{"version":1,"entries":[]}\n');
  put(tokenFile, "t".repeat(48));
  if (process.platform !== "win32") fs.chmodSync(tokenFile, 0o600);
  return { root, dataDir, tokenFile, destination };
}

after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test("restored random master keys decrypt real settings without starting an executor", () => {
  const { SettingsStore, releaseSecretCache } = require("../src/main/settingsStore");
  const context = setup();
  const scope = path.join(context.dataDir, "book-abc");
  const store = new SettingsStore(scope);
  store.save({ apiSecret: "isolated-backup-secret", privateKey: "isolated-signing-material" });
  backup(context);
  const target = path.join(context.root, "validation-data");
  restore({ backupDir: context.destination, dataDir: target, tokenFile: path.join(context.root, "validation.token"), isolatedValidation: true, executorStart: false });
  const restoredScope = path.join(target, "book-abc");
  const restored = new SettingsStore(restoredScope);
  assert.equal(restored.value.apiSecret, store.value.apiSecret);
  assert.equal(restored.value.privateKey, store.value.privateKey);
  assert.ok(!fs.readFileSync(restored.file, "utf8").includes("isolated-backup-secret"));
  releaseSecretCache(scope);
  releaseSecretCache(restoredScope);
});

test("backup and isolated restore preserve owner, tombstones, master keys and every byte", () => {
  const context = setup();
  const original = new Map();
  function capture(directory, prefix = "") {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory()) capture(file, relative);
      else original.set(relative, fs.readFileSync(file));
    }
  }
  capture(context.dataDir);
  original.set("../server.token", fs.readFileSync(context.tokenFile));
  const result = backup(context);
  assert.ok(result.files >= 6);
  assert.equal(fs.existsSync(path.join(context.dataDir, ".service.lock")), false);
  assert.equal(fs.statSync(context.destination).mode & 0o777, process.platform === "win32" ? 0o777 : 0o700);
  assert.doesNotThrow(() => verifyBackup(context.destination));
  const target = path.join(context.root, "isolated-empty");
  const tokenTarget = path.join(context.root, "isolated", "server.token");
  fs.mkdirSync(target, { mode: 0o700 });
  const restored = restore({ backupDir: context.destination, dataDir: target, tokenFile: tokenTarget, isolatedValidation: true, executorStart: false });
  assert.equal(restored.files, result.files);
  for (const [relative, contents] of original) {
    const file = relative === "../server.token" ? tokenTarget : path.join(target, relative);
    assert.deepEqual(fs.readFileSync(file), contents, relative);
  }
  assert.equal(fs.existsSync(path.join(target, ".service.lock")), false);
  assert.ok(fs.existsSync(path.join(target, ".restore-validation.json")), "isolated copy is fenced from service startup");
  const { createService } = require("../src/server/service");
  assert.throws(() => createService({ userDataDir: target, token: "t".repeat(48) }), /restore_validation_executor_blocked/);
});

test("backup refuses active, unreadable and stale runtime locks", () => {
  const active = setup();
  const lock = path.join(active.dataDir, ".service.lock");
  fs.mkdirSync(lock);
  put(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  assert.throws(() => backup(active), { code: "service_active" });
  fs.rmSync(lock, { recursive: true });
  fs.mkdirSync(lock);
  put(path.join(lock, "owner.json"), "not-json");
  assert.throws(() => backup(active), { code: "service_lock_unverified" });
  fs.rmSync(lock, { recursive: true });
  fs.mkdirSync(lock);
  put(path.join(lock, "owner.json"), JSON.stringify({ pid: 2147483647 }));
  assert.throws(() => backup(active), { code: "service_lock_present" });
});

test("backup refuses overwrite and symlinks; restore refuses nonempty target and missing safety flags", () => {
  const context = setup();
  backup(context);
  assert.throws(() => backup(context), { code: "backup_destination_exists" });
  const symlinkContext = setup();
  fs.symlinkSync(path.join(symlinkContext.dataDir, "ownership.json"), path.join(symlinkContext.dataDir, "linked"));
  assert.throws(() => backup(symlinkContext), { code: "symlink_not_allowed" });
  const target = path.join(context.root, "not-empty");
  fs.mkdirSync(target);
  put(path.join(target, "keep"), "do not overwrite");
  assert.throws(() => restore({ backupDir: context.destination, dataDir: target, tokenFile: path.join(context.root, "token2"), isolatedValidation: true, executorStart: false }), { code: "restore_target_not_empty" });
  assert.equal(fs.readFileSync(path.join(target, "keep"), "utf8"), "do not overwrite");
  const tokenTarget = path.join(context.root, "existing-token");
  put(tokenTarget, "must not replace" );
  assert.throws(() => restore({ backupDir: context.destination, dataDir: path.join(context.root, "empty-restore"), tokenFile: tokenTarget, isolatedValidation: true, executorStart: false }), { code: "restore_token_target_exists" });
  assert.equal(fs.readFileSync(tokenTarget, "utf8"), "must not replace");
  assert.throws(() => restoreArgs(["--backup", "x", "--data-dir", "d", "--token-file", "t", "--isolated-validation", "--executor-start=true"]));
  assert.deepEqual(monitorArgs(["--data-dir", "/isolated/data"], { VESPERA_HEALTH_URL: "http://127.0.0.1:8787/healthz" }), { dataDir: "/isolated/data", healthUrl: "http://127.0.0.1:8787/healthz" });
});

test("backup checks contents on restore and rejects modified critical state", () => {
  const context = setup();
  backup(context);
  fs.appendFileSync(path.join(context.destination, "data", "ownership.json"), "tamper");
  assert.throws(() => verifyBackup(context.destination), { code: "backup_checksum_mismatch" });
});

test("preflight checks runtime, private readable token metadata, clock, disk and health without returning secrets", async () => {
  const context = setup();
  const report = await preflight({
    dataDir: context.dataDir,
    tokenFile: context.tokenFile,
    healthUrl: "https://example.invalid/healthz",
    minimumFreeBytes: 1,
    clock: { synchronized: true, source: "test" },
    health: async () => ({ healthy: true, protocol: 1 }),
  });
  assert.equal(report.nodeMajor, Number(process.versions.node.split(".")[0]));
  assert.equal(JSON.stringify(report).includes("t".repeat(32)), false);
  assert.ok(monitorMetrics(context.dataDir, { minimumFreeBytes: 1 }).freeBytes >= 1);
  if (process.platform !== "win32") {
    fs.chmodSync(context.tokenFile, 0o644);
    await assert.rejects(preflight({ dataDir: context.dataDir, tokenFile: context.tokenFile, healthUrl: "http://127.0.0.1/healthz", minimumFreeBytes: 1, clock: { synchronized: true }, health: async () => ({ healthy: true, protocol: 1 }) }), { code: "token_file_permissions_invalid" });
  }
});

test("restore rejects symlink ancestors and accepts the documented no-start CLI", () => {
  const context = setup();
  backup(context);
  const real = path.join(context.root, "real");
  fs.mkdirSync(real);
  const link = path.join(context.root, "linked-parent");
  fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => restore({ backupDir: context.destination, dataDir: path.join(link, "data"), tokenFile: path.join(context.root, "new.token"), isolatedValidation: true, executorStart: false }), { code: "symlink_not_allowed" });
  assert.throws(() => restore({ backupDir: context.destination, dataDir: path.join(context.root, "empty"), tokenFile: path.join(link, "nested", "new.token"), isolatedValidation: true, executorStart: false }), { code: "symlink_not_allowed" });
  assert.equal(fs.readdirSync(real).length, 0);
  assert.deepEqual(restoreArgs(["--backup", "b", "--data-dir", "d", "--token-file", "t", "--isolated-validation", "--executor-start=false"]), { backupDir: "b", dataDir: "d", tokenFile: "t", isolatedValidation: true, executorStart: false });
});

test("health probe accepts only minimal healthy protocol response and refuses remote cleartext", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, protocol: 1 }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  assert.deepEqual(await readHealth(url), { healthy: true, protocol: 1 });
  await assert.rejects(readHealth("http://example.invalid/healthz"), { code: "health_url_must_use_https" });
});
