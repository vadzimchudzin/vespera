"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TelegramConfigStore } = require("./settingsStore");
const { TelegramBot, TelegramError, addOutbox } = require("./telegramBot");

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
const dirs = [];

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-telegram-"));
  dirs.push(dir);
  return new TelegramConfigStore(dir);
}

function fakeHost() {
  return {
    calls: [],
    async call(method, args = []) {
      this.calls.push({ method, args });
      if (method === "snapshot") return {
        mode: "auto", running: false, status: "stopped", strategyId: "sma200_20", strategyName: "SMA 200/20",
        settings: { dryRun: false, baseUsd: "5.00" }, risk: { step: 2, maxSteps: 6, seriesLossUsd: 4 },
        paper: { balance: "1000.00", openBet: null }, liveBalance: { value: "47.25" }, strategies: [{ id: "sma200_20" }],
      };
      if (method === "start") return { ok: true };
      if (method === "stop") return { status: "stopped" };
      if (method === "setMode") return { mode: args[0] };
      if (method === "setStrategy") return { strategyId: args[0] };
      return { ok: true };
    },
  };
}

function privateMessage(updateId, userId, text) {
  const id = Number(userId);
  return { update_id: updateId, message: { from: { id }, chat: { id, type: "private" }, text } };
}

function callback(updateId, userId, data) {
  const id = Number(userId);
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, from: { id }, message: { chat: { id, type: "private" } }, data } };
}

function bot(store, host = fakeHost(), options = {}) {
  return new TelegramBot({ store, host, getOwner: () => ({ owner: options.owner || "server" }), transport: options.transport, now: options.now || Date.now });
}

async function run() {
  const store = createStore();
  store.write({ ...store.read(), token: TOKEN, enabled: true, botUsername: "vespera_test_bot" });
  const disk = fs.readFileSync(store.file, "utf8");
  assert.ok(!disk.includes(TOKEN), "bot token is never stored as plaintext");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  }

  const host = fakeHost();
  const service = bot(store, host);
  const repeatedAccess = await service.processUpdate(privateMessage(0, "222", "/access"));
  assert.equal(repeatedAccess, true);
  const noticesBeforeDuplicate = store.read().outbox.filter((row) => row.chatId === "111" && /Access requested/.test(row.text)).length;
  await service.processUpdate(privateMessage(0, "222", "/access"));
  assert.equal(store.read().outbox.filter((row) => row.chatId === "111" && /Access requested/.test(row.text)).length, noticesBeforeDuplicate,
    "duplicate access requests do not repeatedly notify the administrator");
  await service.processUpdate(privateMessage(1, "222", "/status"));
  assert.equal(host.calls.length, 0, "unapproved private users cannot control the engine");
  assert.match(store.read().outbox.at(-1).text, /Access is not approved/);
  await service.processUpdate({ update_id: 2, message: { from: { id: 222 }, chat: { id: -100, type: "group" }, text: "/start" } });
  assert.equal(host.calls.length, 0, "group chats are ignored");

  const pairingCode = "A1B2C3D4E5F6";
  store.update((config) => { config.pairing = { hash: crypto.createHash("sha256").update(pairingCode).digest("hex"), expiresAt: Date.now() + 60_000 }; });
  await service.processUpdate(privateMessage(3, "111", `/pair ${pairingCode}`));
  assert.deepEqual(store.read().admins, ["111"], "the first admin is bootstrapped by the one-time code");
  assert.equal(store.read().pairing, null);
  await service.processUpdate(privateMessage(4, "222", "/access"));
  await service.processUpdate(privateMessage(5, "222", "/access"));
  assert.equal(store.read().outbox.filter((row) => row.chatId === "111" && /Access requested/.test(row.text)).length, 1,
    "repeated access requests do not notify the administrator again");
  assert.ok(store.read().requests.some((row) => row.userId === "222"));
  await service.processUpdate(callback(6, "111", "approve:222"));
  assert.ok(store.read().users.includes("222"), "root admin can approve a private access request");
  await service.processUpdate(privateMessage(7, "222", "/status"));
  assert.ok(host.calls.some((call) => call.method === "snapshot"));
  assert.match(store.read().outbox.at(-1).text, /Balance: \$47\.25/);
  await service.processUpdate(callback(8, "222", "action:admin"));
  assert.match(store.read().outbox.at(-1).text, /Only the root administrator/);

  const startsBefore = host.calls.filter((call) => call.method === "start").length;
  await service.processUpdate(privateMessage(9, "222", "/start"));
  assert.equal(host.calls.filter((call) => call.method === "start").length, startsBefore, "real start waits for confirmation");
  const challenge = store.read().confirmations.at(-1);
  assert.ok(challenge && challenge.action === "live_start");
  await service.processUpdate(callback(10, "222", `confirm:${challenge.id}`));
  assert.equal(host.calls.filter((call) => call.method === "start").length, startsBefore + 1);
  const rebooted = bot(store, host);
  assert.equal(await rebooted.processUpdate(callback(10, "222", `confirm:${challenge.id}`)), false, "a repeated Telegram update remains deduplicated after restart");
  assert.equal(host.calls.filter((call) => call.method === "start").length, startsBefore + 1, "repeat update cannot repeat a dangerous action");
  assert.ok(!store.read().confirmations.some((row) => row.id === challenge.id), "confirmation is consumed before the engine call");

  const adminCount = host.calls.length;
  const localOwnerBot = bot(store, host, { owner: "local" });
  await localOwnerBot.processUpdate(privateMessage(11, "222", "/stop"));
  assert.equal(host.calls.length, adminCount, "Telegram never impersonates or takes over a desktop owner");

  let time = Date.now() + 10_000;
  const retryStore = createStore();
  retryStore.write({ ...retryStore.read(), token: TOKEN, enabled: true });
  addOutbox(retryStore, "111", "durable notice");
  let tries = 0;
  const retryBot = bot(retryStore, fakeHost(), {
    now: () => time,
    transport: async () => {
      tries += 1;
      const error = new Error("429");
      error.retryAfter = 3;
      error.status = 429;
      throw error;
    },
  });
  await retryBot.flushOutbox();
  const pending = retryStore.read().outbox[0];
  assert.equal(tries, 1);
  assert.equal(pending.nextAt, time + 3000, "429 retry-after is durably honored");
  const afterRestart = bot(retryStore, fakeHost(), { now: () => time, transport: async () => { tries += 1; return true; } });
  await afterRestart.flushOutbox();
  assert.equal(tries, 1, "restart does not send before the persisted retry deadline");
  time += 3000;
  await afterRestart.flushOutbox();
  assert.equal(tries, 2);
  assert.equal(retryStore.read().outbox.length, 0, "successful outbox retry is removed durably");

  const deadLetterStore = createStore();
  deadLetterStore.write({ ...deadLetterStore.read(), token: TOKEN, enabled: true });
  addOutbox(deadLetterStore, "222", "permanently undeliverable");
  addOutbox(deadLetterStore, "111", "healthy delivery");
  const deadLetterAttempts = [];
  const deadLetterBot = bot(deadLetterStore, fakeHost(), { transport: async (_method, payload) => {
    deadLetterAttempts.push(payload.chat_id);
    if (String(payload.chat_id) === "222") throw new TelegramError("telegram_api_rejected", { status: 403, permanent: true });
    return true;
  } });
  await deadLetterBot.flushOutbox();
  await deadLetterBot.flushOutbox();
  assert.deepEqual(deadLetterAttempts, ["222", "111"], "a permanent 403 is dead-lettered so healthy recipients continue");
  assert.equal(deadLetterStore.read().deadLetters.length, 1, "permanent delivery failure is retained durably");
  assert.equal(deadLetterBot.status().deadLetterCount, 1);
  assert.match(deadLetterBot.status().lastError, /permanent_403/, "permanent failure remains visible after healthy delivery");

  const lockedStore = createStore();
  lockedStore.write({ ...lockedStore.read(), token: TOKEN, enabled: true, admins: ["111"] });
  const lockedHost = fakeHost();
  await bot(lockedStore, lockedHost, { owner: "local" }).processUpdate(privateMessage(1, "111", "/start"));
  assert.equal(lockedHost.calls.length, 0, "a Telegram identity has no control when local ownership is active");

  const revokedStore = createStore();
  revokedStore.write({ ...revokedStore.read(), token: TOKEN, enabled: true, admins: ["111"], users: ["222"] });
  const revokedHost = fakeHost();
  const revokedBot = bot(revokedStore, revokedHost);
  await revokedBot.processUpdate(privateMessage(1, "222", "/start"));
  const revokedChallenge = revokedStore.read().confirmations.at(-1);
  revokedStore.update((config) => { config.users = []; });
  await revokedBot.processUpdate(callback(2, "222", `confirm:${revokedChallenge.id}`));
  assert.equal(revokedHost.calls.filter((call) => call.method === "start").length, 0,
    "a revoked user cannot consume an earlier live-start confirmation");
  addOutbox(revokedStore, "222", "private financial update");
  addOutbox(revokedStore, "111", "admin update");
  await revokedBot.processUpdate(privateMessage(3, "111", "/revoke 222"));
  assert.ok(!revokedStore.read().outbox.some((row) => row.chatId === "222"), "revoking a user removes queued private financial updates");
  assert.ok(revokedStore.read().outbox.some((row) => row.chatId === "111"), "revocation preserves other users' queued updates");

  const changedStore = createStore();
  changedStore.write({ ...changedStore.read(), token: TOKEN, enabled: true, admins: ["111"], users: ["222"] });
  const changedHost = fakeHost();
  const changedBot = bot(changedStore, changedHost);
  await changedBot.processUpdate(privateMessage(1, "222", "/start"));
  const changedChallenge = changedStore.read().confirmations.at(-1);
  changedHost.call = async function (method, args = []) {
    this.calls.push({ method, args });
    if (method === "snapshot") return { ...await fakeHost().call("snapshot"), settings: { dryRun: false, baseUsd: "50.00" } };
    if (method === "start") return { ok: true };
    return { ok: true };
  };
  await changedBot.processUpdate(callback(2, "222", `confirm:${changedChallenge.id}`));
  assert.equal(changedHost.calls.filter((call) => call.method === "start").length, 0,
    "risk-setting changes invalidate a pending live-start confirmation");

  const unauthorizedStore = createStore();
  const unauthorizedHost = fakeHost();
  const unauthorized = bot(unauthorizedStore, unauthorizedHost, {
    transport: async () => { throw new TelegramError("telegram_api_rejected", { status: 401, permanent: true }); },
  });
  await assert.rejects(TelegramBot.testToken(TOKEN, unauthorized.transport), (error) => error.status === 401);
  const unsafe = await unauthorizedHost.call("snapshot");
  assert.ok(unsafe && !JSON.stringify(unauthorizedStore.read()).includes(TOKEN), "unauthorized token failures never persist credentials");

  const cappedStore = {
    state: { outbox: Array.from({ length: 1000 }, (_, index) => ({ id: String(index) })), lastError: null },
    update(fn) { fn(this.state); },
  };
  assert.equal(addOutbox(cappedStore, "111", "extra"), false, "outbox capacity never evicts undelivered records");
  assert.equal(cappedStore.state.outbox.length, 1000);
  assert.equal(cappedStore.state.lastError, "telegram_outbox_full");

  const menuStore = createStore();
  menuStore.write({ ...menuStore.read(), token: TOKEN, enabled: true, admins: ["111"], users: ["222"] });
  const menuHost = fakeHost();
  const menuBot = bot(menuStore, menuHost);
  await menuBot.processUpdate(privateMessage(1, "111", "/strategy"));
  assert.equal(menuStore.read().outbox.at(-1).keyboard[0][0].callback_data, "strategy:sma200_20");
  await menuBot.processUpdate(callback(2, "111", "strategy:sma200_20"));
  assert.ok(menuHost.calls.some((row) => row.method === "setStrategy" && row.args[0] === "sma200_20"));
  await menuBot.processUpdate(callback(3, "111", "mode:paper"));
  assert.ok(menuHost.calls.some((row) => row.method === "setMode" && row.args[0] === "paper"));
  await menuBot.processUpdate(callback(4, "222", "revoke:111"));
  assert.deepEqual(menuStore.read().admins, ["111"], "approved users cannot revoke administrator access");
  await menuBot.processUpdate(callback(5, "111", "revoke:222"));
  assert.deepEqual(menuStore.read().users, [], "admin revokes access through the button");

  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log("telegram bot tests ok");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
