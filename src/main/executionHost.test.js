"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("./executionHost");
const { TelegramError } = require("./telegramBot");

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

  const telegramMessages = [];
  let pollCount = 0;
  const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
  const telegramHost = new ExecutionHost({ userDataDir: dir(), engineOptions: {
    ...options(),
    telegramTransport: async (method, payload, timeout, signal) => {
      if (method === "getMe") return { id: 123456789, username: "host_test_bot" };
      if (method === "sendMessage") { telegramMessages.push(payload); return { message_id: telegramMessages.length }; }
      if (method === "getUpdates") {
        pollCount += 1;
        return new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("aborted"), { code: "telegram_poll_cancelled" }));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error(`unexpected_${method}`);
    },
  } });
  assert.deepStrictEqual(await telegramHost.call("telegramStatus"), {
    enabled: false, connected: false, botName: null, hasToken: false, adminId: null, users: [], pendingRequests: 0, failedDeliveries: 0, lastError: null,
  });
  assert.deepStrictEqual(await telegramHost.call("telegramConfigure", [{ token: "invalid-token", enabled: true }]), {
    ok: false, reason: "telegram_token_invalid",
  });
  assert.deepStrictEqual(await telegramHost.call("telegramConfigure", [{ token: telegramToken, enabled: false }]), {
    ok: true, enabled: false, botName: "host_test_bot",
  });
  assert.equal((await telegramHost.call("telegramPair")).reason, "telegram_not_enabled");
  assert.deepStrictEqual(await telegramHost.call("telegramConfigure", [{ enabled: true }]), {
    ok: true, enabled: true, botName: "host_test_bot",
  });
  const pairing = await telegramHost.call("telegramPair");
  assert.equal(pairing.ok, true);
  assert.equal((await telegramHost.call("telegramTest")).reason, "telegram_admin_not_paired");
  const routed = [];
  const serialized = [];
  await telegramHost.setTelegramContext({
    active: true,
    epoch: 3,
    serialize: async (work) => { serialized.push(true); return work(); },
    command: async (method, args) => {
      routed.push({ method, args });
      if (method === "snapshot") return { mode: "paper", running: false, status: "stopped", settings: { dryRun: true }, paper: { balance: "1000.00" } };
      return { ok: true };
    },
  });
  await telegramHost.telegramBot.processUpdate({ update_id: 1, message: {
    from: { id: 42 }, chat: { id: 42, type: "private" }, text: `/pair ${pairing.code}`,
  } });
  assert.equal((await telegramHost.call("telegramStatus")).adminId, "42");
  assert.equal((await telegramHost.call("telegramTest")).ok, true);
  assert.equal(telegramMessages.at(-1).chat_id, "42", "test action sends a real test message to the paired root admin");
  await telegramHost.telegramBot.processUpdate({ update_id: 2, message: {
    from: { id: 42 }, chat: { id: 42, type: "private" }, text: "/status",
  } });
  assert.ok(routed.some((call) => call.method === "snapshot"), "local Telegram execution goes through the supplied router command");
  assert.ok(serialized.length > 0, "local Telegram updates use the router's serialized command queue");
  assert.ok(pollCount > 0, "polling starts only while the local owner context is active");
  await telegramHost.setTelegramContext({ active: false });
  assert.equal((await telegramHost.call("telegramStatus")).connected, false);
  const protectedTelegram = fs.readFileSync(telegramHost.telegramStore.file, "utf8");
  assert.ok(!protectedTelegram.includes(telegramToken), "protected Telegram storage does not contain a plaintext token");
  assert.ok(!JSON.stringify(await telegramHost.call("telegramStatus")).includes(telegramToken), "status never returns token material");
  const replacementToken = "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBAabcdefghijk";
  telegramHost.telegramStore.update((config) => {
    config.lastUpdateId = 99;
    config.outbox.push({ id: "old-token-job", chatId: "42", text: "old bot notice", attempts: 0, nextAt: Date.now() });
  });
  assert.equal((await telegramHost.call("telegramConfigure", [{ token: replacementToken, enabled: false }])).ok, true);
  const replaced = telegramHost.telegramStore.read();
  assert.deepEqual(replaced.admins, [], "changing bot identity removes old administrators");
  assert.equal(replaced.lastUpdateId, null, "updates from the prior bot identity cannot be acknowledged on the new bot");
  assert.equal(replaced.outbox.length, 0, "old outbox jobs are never sent through a replacement bot token");
  assert.deepStrictEqual(await telegramHost.call("telegramConfigure", [{ enabled: false }]), {
    ok: true, enabled: false, botName: "host_test_bot",
  });
  assert.deepStrictEqual(await telegramHost.call("telegramDisconnect"), { ok: true, disconnected: true });
  assert.deepStrictEqual((await telegramHost.call("telegramStatus")).users, []);

  const unauthorizedHost = new ExecutionHost({ userDataDir: dir(), engineOptions: {
    ...options(),
    telegramTransport: async () => { throw new TelegramError("telegram_api_rejected", { status: 401, permanent: true }); },
  } });
  assert.deepStrictEqual(await unauthorizedHost.call("telegramConfigure", [{ token: telegramToken, enabled: true }]), {
    ok: false, reason: "telegram_api_rejected",
  });
  assert.equal((await unauthorizedHost.call("telegramStatus")).hasToken, false, "unauthorized credentials are never persisted");
  local.dispose();
  reopened.dispose();
  telegramHost.dispose();
  unauthorizedHost.dispose();
  console.log("execution host tests ok");
}
run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const value of dirs) fs.rmSync(value, { recursive: true, force: true });
});
