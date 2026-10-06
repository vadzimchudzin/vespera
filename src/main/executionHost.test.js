"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("./executionHost");

const dirs = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-host-")); dirs.push(value); return value; }
function options() {
  return {
    market: { bars: [], on() {}, start() {}, stop() {} },
    live: { configure() {}, async getQuote() { return null; } },
  };
}

async function run() {
  const events = [];
  const local = new ExecutionHost({ userDataDir: dir(), engineOptions: options(), onEvent: (e) => events.push(e) });
  await local.call("saveSettings", [{ sizingMode: "fixed", fixedStakes: [5, 10, 20], apiKey: "secret-test-key", privateKey: "private-test-key", proxyUrl: "socks5://proxy.invalid:1080" }]);
  assert.ok(!JSON.stringify(events).includes("secret-test-key"), "events do not expose private settings");
  assert.ok(!(await local.call("getSettings")).privateKey);
  local.engine.journal.write({ type: "settled", side: "UP", sizeUsd: "5.00", status: "loss", pnl: "-5.18", balanceAfter: "994.82" });
  local.engine.risk.onLoss(5.18);
  local.engine.paper.balance = require("./money").Decimal("994.82");
  const bundle = local.exportBundle();
  assert.strictEqual(bundle.settings.privateKey, "private-test-key", "transfer privately includes account settings");
  const serverDir = dir();
  const server = new ExecutionHost({ userDataDir: serverDir, direct: true, engineOptions: options() });
  await server.importBundle(bundle);
  assert.strictEqual(server.engine.settings.proxyUrl, "", "server never keeps a transferred proxy");
  assert.deepStrictEqual(server.engine.risk.fixedStakes, [5, 10, 20]);
  assert.strictEqual(server.engine.risk.step, 2);
  assert.strictEqual(server.engine.paper.balance.toFixed(2), "994.82");
  assert.strictEqual(server.engine.running, false, "handoff does not automatically start trading");
  await server.call("saveSettings", [{ proxyUrl: "http://proxy.invalid:9000" }]);
  assert.strictEqual(server.engine.settings.proxyUrl, "");
  const disk = fs.readFileSync(server.store.file, "utf8");
  assert.ok(!disk.includes("private-test-key"), "transferred credentials are encrypted at rest");
  server.dispose();
  const reopened = new ExecutionHost({ userDataDir: serverDir, direct: true, engineOptions: options() });
  assert.strictEqual(reopened.engine.risk.step, 2, "epoch pointer preserves transferred state after restart");
  assert.strictEqual(reopened.engine.paper.balance.toFixed(2), "994.82");
  await local.importBundle(reopened.exportBundle());
  assert.strictEqual(local.engine.settings.proxyUrl, "socks5://proxy.invalid:1080", "local proxy remains a per-machine connection setting");
  local.engine.paper.openBet = { side: "UP", sizeUsd: "5" };
  assert.throws(() => local.exportBundle(), (err) => err.code === "execution_busy");
  assert.throws(() => local.quiesce(), (err) => err.code === "execution_busy");
  local.engine.paper.openBet = null;
  const corrupt = JSON.parse(JSON.stringify(bundle));
  corrupt.checkpoint.entries.push({ type: "order_sent", side: "UP", sizeUsd: "5", mode: "auto" });
  await assert.rejects(reopened.importBundle(corrupt), (err) => err.code === "transfer_has_position");
  assert.strictEqual(reopened.engine.risk.step, 2, "rejected transfers leave the old core intact");
  local.dispose();
  reopened.dispose();
  console.log("execution host tests ok");
}
run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
});
