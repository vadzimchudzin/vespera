"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("./executionHost");
const { ExecutionRouter } = require("./executionRouter");
const { createService } = require("../server/service");

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
const AUTH = "isolated-service-token-" + "a".repeat(40);
const roots = [];
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-tg-integration-"));
  roots.push(dir);
  return dir;
}
const deliveries = [];
async function transport(method, payload) {
  if (method === "getMe") return { id: 123456789, username: "isolated_test_bot" };
  if (method === "getUpdates") return new Promise((resolve) => setTimeout(() => resolve([]), 20));
  if (method === "sendMessage") deliveries.push(payload);
  return true;
}
function engineOptions() {
  return {
    market: { bars: [], on() {}, start() {}, stop() {}, async loadHistory() {} },
    live: { configure() {}, async getQuote() { return null; } },
    telegramTransport: transport,
  };
}
function message(id, text, user = 111) {
  return { update_id: id, message: { from: { id: user }, chat: { id: user, type: "private" }, text } };
}

async function run() {
  let router;
  let service;
  try {
    const desktopRoot = root();
    const host = new ExecutionHost({ userDataDir: desktopRoot, engineOptions: engineOptions() });
    router = new ExecutionRouter({ userDataDir: desktopRoot, host, pollMs: 100000 });
    assert.equal((await router.dispatch("telegramConfigure", [{ token: TOKEN, enabled: true }])).ok, true);
    const status = await router.dispatch("telegramStatus");
    assert.equal(status.hasToken, true);
    assert.equal(status.botName, "isolated_test_bot");
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    const pairing = await router.dispatch("telegramPair");
    assert.equal(pairing.ok, true);
    await host.telegramBot.processUpdate(message(1, `/pair ${pairing.code}`));
    assert.equal((await router.dispatch("telegramStatus")).adminId, "111");
    assert.equal((await router.dispatch("telegramTest")).ok, true);
    assert.ok(deliveries.some((item) => String(item.chat_id) === "111"));
    await host.telegramBot.processUpdate(message(2, "/start"));
    assert.equal(host.engine.running, true, "local bot starts the existing Paper engine through the router");
    await host.telegramBot.processUpdate(message(3, "/stop"));
    assert.equal(host.engine.running, false);
    assert.equal((await router.dispatch("telegramConfigure", [{ enabled: false }])).ok, true, "toggle works without re-entering saved token");
    assert.equal((await router.dispatch("telegramStatus")).hasToken, true);

    const serverRoot = root();
    service = createService({
      userDataDir: serverRoot, token: AUTH, telegramTransport: transport,
      hostFactory: (options) => new ExecutionHost({ ...options, engineOptions: engineOptions() }),
    });
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${service.server.address().port}`;
    await router.configure({ url, token: AUTH });
    assert.equal((await router.switchMode("server")).ok, true);
    assert.equal((await router.dispatch("telegramStatus")).hasToken, false, "bot credentials are not cloned with the trading book");
    assert.equal((await router.dispatch("telegramConfigure", [{ token: TOKEN, enabled: true }])).ok, true);
    const serverPair = await router.dispatch("telegramPair");
    assert.equal(serverPair.ok, true);
    await service.host.telegramBot.processUpdate(message(1, `/pair ${serverPair.code}`));
    await service.host.telegramBot.processUpdate(message(2, "/start"));
    assert.equal(service.host.engine.running, true, "server Telegram starts the existing server engine");
    assert.equal(service.owner.desiredRunning, true, "Telegram start persists server restart intent");
    assert.equal(host.engine.running, false, "desktop remains standby");
    await service.host.telegramBot.processUpdate(message(3, "/stop"));
    assert.equal(service.owner.desiredRunning, false);
    const queuedBefore = service.host.telegramStore.read().outbox.length;
    service.host.engine.emit("order", { side: "UP", sizeUsd: "5.00", price: 0.5, feeUsd: "0.18" });
    assert.equal(service.host.telegramStore.read().outbox.length, queuedBefore + 1, "one engine event creates one notification per recipient");
    service.host.engine.paper.openBet = { side: "UP", sizeUsd: "5.00" };
    assert.equal((await router.switchMode("local")).ok, false);
    assert.equal(service.owner.owner, "server");
    assert.equal(service.host.telegramBot.stopped, false, "refused handoff does not disable the server bot");
    service.host.engine.paper.openBet = null;
    await host.telegramBot.processUpdate(message(4, "/start"));
    assert.equal(host.engine.running, false, "standby local bot cannot start a duplicate engine");
    assert.ok(!JSON.stringify(host.exportBundle()).includes(TOKEN));
    assert.equal((await router.dispatch("telegramDisconnect")).ok, true);
    assert.equal((await router.dispatch("telegramStatus")).hasToken, false);
    assert.equal((await router.dispatch("telegramStatus")).adminId, null);
    console.log("Telegram local/server integration tests ok");
  } finally {
    router?.dispose();
    await service?.close();
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
