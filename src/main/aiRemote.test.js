"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExecutionHost } = require("./executionHost");
const { ExecutionRouter } = require("./executionRouter");
const { createService } = require("../server/service");

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-ai-http-"));
  let finish;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const result = new Promise((resolve) => { finish = resolve; });
  const request = async (url) => {
    if (url.endsWith("/models")) return { status: 200, text: async () => JSON.stringify({ data: [{ id: "fixture/mock", context_length: 100000, supported_parameters: ["structured_outputs", "response_format"], pricing: { prompt: "0.000001", completion: "0.000002" } }] }) };
    assert.ok(url.endsWith("/chat/completions"));
    began();
    await result;
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ explanation: "Isolated recommendation", patch: { fastPeriod: 21 } }) } }], usage: { cost: 0.001, prompt_tokens: 200, completion_tokens: 30 } }) };
  };
  const options = () => ({ market: { bars: [], on() {}, start() {}, stop() {}, async loadHistory() {} }, live: { configure() {} }, aiRequest: request });
  const desktop = new ExecutionHost({ userDataDir: path.join(root, "desktop"), engineOptions: options() });
  const router = new ExecutionRouter({ userDataDir: path.join(root, "desktop"), host: desktop, pollMs: 100000 });
  const token = "isolated-http-token-" + "a".repeat(40);
  const service = createService({ userDataDir: path.join(root, "server"), token, hostFactory: (input) => new ExecutionHost({ ...input, engineOptions: options() }) });
  try {
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const setup = await router.dispatch("saveSetup", [{ name: "Advisory base" }]);
    await router.configure({ url: `http://127.0.0.1:${service.server.address().port}`, token });
    assert.equal((await router.switchMode("server")).ok, true);
    await router.dispatch("aiConfigure", [{ provider: "openrouter", model: "fixture/mock", key: "isolated-key", enabled: true, dailyBudgetUsd: 1, maxRequestUsd: 0.1 }]);
    service.host.engine.running = true;
    const recommendation = router.dispatch("aiRecommend", [{ id: setup.setup.id, version: 1 }]);
    await started;
    const stop = router.dispatch("stop");
    const winner = await Promise.race([stop.then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 500))]);
    assert.equal(winner, "stopped", "model IO must not block trading Stop through HTTP or desktop queue");
    assert.equal(service.host.engine.running, false);
    finish();
    const proposed = await recommendation;
    assert.equal(proposed.ok, true);
    assert.equal(service.host.engine.settings.fastPeriod, 20, "advice never applies itself");
    assert.ok(!JSON.stringify(await router.dispatch("aiStatus")).includes("isolated-key"));
    console.log("AI HTTP Stop responsiveness and no-application tests ok");
  } finally {
    finish?.(); router.dispose(); await service.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
