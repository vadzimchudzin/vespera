"use strict";

// The agents desk inside Vespera: the execution host's calls, ownership (only the owning side works), the router
// (read-only views never queue, a server is read with GET /v1/agents), the service routes and the Telegram commands.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ExecutionHost } = require("../executionHost");
const { ExecutionRouter } = require("../executionRouter");
const { TelegramBot } = require("../telegramBot");
const { createService } = require("../../server/service");

const NOW = Date.UTC(2026, 10, 4, 12);
const TOKEN = "integration-test-token-with-at-least-thirty-two-bytes";
const BOT = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";
const dirs = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `vespera-agents-${name}-`)); dirs.push(d); return d; };
const quietNet = { json: async () => [], text: async () => "" };
const options = () => ({
  market: { bars: [], on() {}, start() {}, stop() {} },
  live: { configure() {}, async getQuote() { return null; } },
  agentsNet: quietNet, agentsNow: () => NOW, agentsAutoTick: false,
});
const message = (id, user, text) => ({ update_id: id, message: { from: { id: Number(user) }, chat: { id: Number(user), type: "private" }, text } });
const press = (id, user, data) => ({ update_id: id, callback_query: { id: `cb-${id}`, from: { id: Number(user) }, message: { chat: { id: Number(user), type: "private" } }, data } });

async function hostCalls() {
  const events = [];
  const root = tmp("host");
  const host = new ExecutionHost({ userDataDir: root, engineOptions: options(), onEvent: (e) => events.push(e) });
  assert.ok(host.agents, "every host has a desk");
  assert.strictEqual(host.agents.root, path.join(root, "agents"), "the desk lives at the root, outside any book");

  let s = await host.call("agentsStatus");
  assert.deepStrictEqual([s.ok, s.mode, s.running, s.active, s.startCapital], [true, "paper", false, false, 1000]);
  s = await host.call("agentsConfigure", [{ perTradeUsd: 10 }]);
  assert.strictEqual(s.config.perTradeUsd, 10);
  assert.deepStrictEqual(await host.call("agentsConfigure", [{ mode: "live" }]), { ok: false, reason: "agents_live_requires_certificate" });
  assert.deepStrictEqual(await host.call("agentsConfigure", [{ perTradeUsd: -1 }]), { ok: false, reason: "agents_config_invalid" });
  assert.deepStrictEqual(await host.call("agentsAgent", [{ id: "nobody", action: "pause" }]), { ok: false, reason: "agents_agent_not_found" });
  assert.deepStrictEqual(await host.call("agentsReport", [{ period: "year" }]), { ok: false, reason: "agents_period_invalid" });
  assert.deepStrictEqual(await host.call("agentsReset", [{ capitalUsd: 500 }]), { ok: false, reason: "agents_confirmation_required" });

  s = await host.call("agentsStart");
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.journal.find((row) => row.kind === "start").by, "ui", "the app is the default caller");
  const agent = s.agents[0];
  s = await host.call("agentsAgent", [{ id: agent.id, action: "pause" }]);
  assert.strictEqual(s.agents.find((a) => a.id === agent.id).status, "paused");
  s = await host.call("agentsAgent", [{ id: agent.id, action: "resume" }]);
  assert.strictEqual(s.agents.find((a) => a.id === agent.id).status, "active");

  const sent = [];
  host.telegramBot = { enqueueEvent: (e) => sent.push(e) };
  s = await host.call("agentsKill", [{ by: "telegram" }]);
  assert.deepStrictEqual([s.running, s.halt.reason, s.halt.by], [false, "manual", "telegram"]);
  assert.ok(sent.some((e) => e.type === "agents_alert" && e.payload.kind === "halt"), "alerts reach the bot");
  assert.ok(events.some((e) => e.type === "agents_alert") && events.some((e) => e.type === "agents"), "and the app");
  s = await host.call("agentsResume", [{ by: "telegram" }]);
  assert.deepStrictEqual([s.running, s.halt], [true, null]);
  s = await host.call("agentsStop");
  assert.strictEqual(s.running, false);
  host.telegramBot = null;

  const r = await host.call("agentsReport", [{ period: "week" }]);
  assert.deepStrictEqual([r.ok, r.period], [true, "week"]);
  const ring = await host.call("agentsRing");
  assert.deepStrictEqual([ring.ok, ring.events, ring.open], [true, [], 0]);
  s = await host.call("agentsReset", [{ capitalUsd: 500, confirm: true }]);
  assert.deepStrictEqual([s.startCapital, s.equity, s.running], [500, 500, false]);

  // the desk works only on the side that owns execution, like research
  host.setResearchContext({ active: true });
  assert.strictEqual(host.agents.active, true);
  host.quiesce();
  assert.strictEqual(host.agents.active, false);
  host.setResearchContext({ active: true });

  // a setup activation in recovery does not lock the desk out
  host._activationRecoveryPending = true;
  assert.strictEqual((await host.call("agentsStatus")).ok, true);
  assert.strictEqual((await host.call("start")).reason, "setup_activation_recovery_pending");
  host._activationRecoveryPending = false;

  // a transfer neither carries nor copies the desk: the candidate host has none, and ours comes back as it was
  const bundle = host.exportBundle();
  assert.ok(!JSON.stringify(bundle).includes("startCapital"), "no agents state in a bundle");
  host.setResearchContext({ active: false });
  await host.importBundle(bundle);
  const books = fs.readdirSync(root).filter((name) => name.startsWith("book-"));
  assert.strictEqual(books.length, 1);
  assert.ok(!fs.existsSync(path.join(root, books[0], "agents")), "the candidate book has no desk of its own");
  assert.strictEqual(host.agents.disposed, false);
  s = await host.call("agentsStatus");
  assert.deepStrictEqual([s.ok, s.startCapital], [true, 500]);

  host.dispose();
  assert.strictEqual(host.agents.disposed, true);
  assert.deepStrictEqual(await host.call("agentsStart"), { ok: false, reason: "agents_disposed" });
  const reopened = new ExecutionHost({ userDataDir: root, engineOptions: options() });
  assert.strictEqual((await reopened.call("agentsStatus")).startCapital, 500, "the paper book survives a restart");
  reopened.dispose();
}

async function routerViews() {
  const hostSeen = [];
  const host = {
    engine: { snapshot: () => ({ status: "stopped" }) },
    quiesce() { return true; }, idle() { return true; }, setResearchContext() {}, async setTelegramContext() {},
    async call(method, args) { hostSeen.push({ method, args }); return { ok: true, method }; },
    dispose() {},
  };
  const requests = [];
  const client = { async request(route, body) { requests.push({ route, body }); return route.startsWith("/v1/agents") ? { ok: true, route } : { ok: true, method: body.method }; } };
  const router = new ExecutionRouter({ userDataDir: tmp("router"), host, clientFactory: () => client, pollMs: 60000 });
  let release;
  router._serial(() => new Promise((resolve) => { release = resolve; }));
  assert.strictEqual((await router.dispatch("agentsStatus")).method, "agentsStatus", "a view never waits for the queue");
  let killed = false;
  const kill = router.dispatch("agentsKill").then(() => { killed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(killed, false, "commands keep their place in the queue");
  release();
  await kill;
  assert.deepStrictEqual(hostSeen.map((c) => c.method), ["agentsStatus", "agentsKill"]);

  router.mode = "server";
  await router.dispatch("agentsStatus");
  await router.dispatch("agentsReport", [{ period: "week" }]);
  await router.dispatch("agentsRing");
  await router.dispatch("agentsStart");
  assert.deepStrictEqual(requests.map((r) => r.route), ["/v1/agents?view=status", "/v1/agents?view=report&period=week", "/v1/agents?view=ring", "/v1/command"]);
  assert.strictEqual(requests[0].body, undefined, "views are a GET");
  assert.strictEqual(requests[3].body.method, "agentsStart");
  assert.strictEqual(hostSeen.length, 2, "the local desk is not asked while the server owns execution");
  router.mode = "local";
  router.dispose();
}

async function serviceRoutes() {
  const userDataDir = tmp("service");
  fs.writeFileSync(path.join(userDataDir, "ownership.json"), JSON.stringify({ protocol: 1, owner: "server", deviceId: "desktop-a", epoch: 1,
    desiredRunning: false, lastSeenAt: null, activationRequestId: null, registrationRequestId: null }));
  const service = createService({ userDataDir, token: TOKEN, hostFactory: (o) => new ExecutionHost({ ...o, engineOptions: options() }) });
  const host = service.host;
  service.server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { service.server.once("listening", resolve); service.server.once("error", reject); });
  const root = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (route, body, auth = true) => {
    const res = await fetch(`${root}${route}`, { method: body ? "POST" : "GET",
      headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.strictEqual((await call("/v1/agents?view=status", null, false)).status, 401);
    let res = await call("/v1/agents?view=status");
    assert.deepStrictEqual([res.status, res.body.ok, res.body.mode], [200, true, "paper"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(host.agents.active, true, "the server's desk works while the server owns execution");
    res = await call("/v1/agents?view=report&period=week");
    assert.deepStrictEqual([res.body.ok, res.body.period], [true, "week"]);
    assert.strictEqual((await call("/v1/agents?view=ring")).body.ok, true);
    assert.strictEqual((await call("/v1/agents?view=secrets")).status, 400);
    assert.strictEqual((await call("/v1/agents?view=report&period=year")).status, 400);
    res = await call("/v1/command", { method: "agentsKill", args: [{}], deviceId: "desktop-a", requestId: "agents-kill-1" });
    assert.deepStrictEqual([res.status, res.body.halt.reason, res.body.halt.by], [200, "manual", "ui"]);
    res = await call("/v1/command", { method: "agentsConfigure", args: [{ mode: "live" }], deviceId: "desktop-a", requestId: "agents-live-1" });
    assert.deepStrictEqual(res.body, { ok: false, reason: "agents_live_requires_certificate" });
    const events = (await call("/v1/events?after=0")).body.events;
    assert.ok(events.some((e) => e.type === "agents_alert" && e.payload.kind === "halt"));
  } finally {
    await service.close();
  }
  assert.strictEqual(host.agents.disposed, true);
  // a server that does not own execution answers without asking its desk
  const standbyDir = tmp("standby");
  const standby = createService({ userDataDir: standbyDir, token: TOKEN, host: new ExecutionHost({ userDataDir: standbyDir, direct: true, engineOptions: options() }) });
  standby.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => standby.server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${standby.server.address().port}/v1/agents?view=status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepStrictEqual(await res.json(), { ok: false, reason: "not_server_owner" });
  } finally { await standby.close(); }
}

async function telegram() {
  const host = new ExecutionHost({ userDataDir: tmp("telegram"), direct: true, engineOptions: options() });
  host.telegramStore.write({ ...host.telegramStore.read(), token: BOT, enabled: true, botUsername: "vespera_test_bot", admins: ["111"] });
  const bot = new TelegramBot({ store: host.telegramStore, host, getOwner: () => ({ owner: "server" }), transport: async () => ({ ok: true, result: true }), now: () => NOW });
  host.telegramBot = bot;
  const outbox = () => host.telegramStore.read().outbox;
  const last = () => outbox().at(-1);
  let id = 1;
  await bot.processUpdate(message(id++, "111", "/menu"));
  assert.ok(last().keyboard.flat().some((b) => b.callback_data === "action:agents"), "the menu has the agents' button");
  await bot.processUpdate(press(id++, "111", "action:agents"));
  assert.match(last().text, /^Agents · paper · stopped/);
  assert.ok(last().keyboard.flat().some((b) => b.callback_data === "agents:stop"));
  await bot.processUpdate(message(id++, "111", "/agents_start"));
  assert.match(last().text, /^Agents · paper · running/);
  const before = outbox().length;
  await bot.processUpdate(message(id++, "111", "/agents_stop"));
  const news = outbox().slice(before).map((row) => row.text);
  assert.ok(news.some((t) => /^Agents halted — by hand \(Telegram\)/.test(t)), "the halt alert goes out");
  assert.ok(news.some((t) => /^Emergency stop accepted/.test(t)));
  assert.strictEqual(host.agents.state.halt.by, "telegram");
  await bot.processUpdate(press(id++, "111", "agents:start"));
  assert.match(last().text, /^Agents · paper · running/, "Telegram clears its own manual stop");
  await bot.processUpdate(press(id++, "111", "agents:report"));
  assert.match(last().text, /^Agents · daily report \(paper\)/);
  host.agents.state.halt = { reason: "drawdown", at: NOW, equity: 840, limit: 850 };
  host.agents.state.running = false;
  await bot.processUpdate(message(id++, "111", "/agents_start"));
  assert.match(last().text, /Only the app can clear this halt/);
  assert.strictEqual((await host.call("agentsResume")).running, true, "the app can");
  await bot.processUpdate(message(id++, "222", "/agents_stop"));
  assert.strictEqual(host.agents.state.running, true, "unapproved users cannot stop the desk");
  host.engine.settings.locale = "ru";
  await bot.processUpdate(message(id++, "111", "/agents"));
  assert.match(last().text, /^Агенты · бумага · работают/);
  await bot.processUpdate(message(id++, "111", "/unknown"));
  assert.match(last().text, /\/agents_stop/, "the help lists the agents' commands");
  const standby = new TelegramBot({ store: host.telegramStore, host, getOwner: () => ({ owner: "local", active: false }), transport: async () => ({ ok: true, result: true }), now: () => NOW });
  await standby.processUpdate(message(id++, "111", "/agents_stop"));
  assert.strictEqual(host.agents.state.running, true, "a standby side never acts");
  host.dispose();
}

async function main() {
  await hostCalls();
  await routerViews();
  await serviceRoutes();
  await telegram();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log("agents integration tests ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
