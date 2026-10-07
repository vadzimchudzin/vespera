"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExecutionHost } = require("./executionHost");

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-ai-workflow-"));
  const bars = Array.from({ length: 1000 }, (_, i) => {
    const close = 100 + i * 0.1 + Math.sin(i * 0.3) * 3;
    return { openTs: i * 900000, closeTs: (i + 1) * 900000 - 1, open: close - 0.1, close, high: close + 0.5, low: close - 0.5, closed: true };
  });
  const sent = [];
  const request = async (url, body) => {
    sent.push(body);
    return { status: 200, text: async () => JSON.stringify(url.endsWith("/models")
      ? { data: [{ id: "fixture/mock", context_length: 100000, pricing: { prompt: "0.0000001", completion: "0.0000002" } }] }
      : { choices: [{ message: { content: JSON.stringify({ explanation: "A test-only indicator suggestion.", patch: { fastPeriod: 24 } }) } }], usage: { cost: 0.0001, prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
  };
  let host = new ExecutionHost({ userDataDir: root, engineOptions: { market: { symbol: "BTCUSDT", timeframe: "15m", bars, on() {}, start() {}, stop() {} }, live: { configure() {} }, aiRequest: request } });
  try {
    const base = (await host.call("saveSetup", [{ name: "Base not modified" }])).setup;
    await host.call("aiConfigure", [{ model: "fixture/mock", key: "isolated-key", enabled: true }]);
    const advice = await host.call("aiRecommend", [{ id: base.id, version: 1 }]);
    assert.equal(advice.ok, true);
    assert.equal(advice.recommendation.provider, "openrouter");
    assert.equal(advice.recommendation.model, "fixture/mock");
    assert.ok(!JSON.stringify(sent).includes("isolated-key"));
    assert.ok(!JSON.stringify(sent).includes("priorApproximateBacktests"), "validation data is not disclosed to the model");
    await assert.rejects(host.call("aiCreateSetup", [{ recommendationId: advice.recommendation.id, name: "Candidate" }]), /ai_confirmation_required/);
    const candidate = await host.call("aiCreateSetup", [{ recommendationId: advice.recommendation.id, name: "Candidate", confirm: true }]);
    assert.notEqual(candidate.candidateSetup.id, base.id);
    assert.equal(host.engine.activeSetupSnapshot().id, base.id);
    assert.equal(host.engine.settings.fastPeriod, 20);
    assert.equal(host.engine.running, false);
    const validation = await host.call("aiBacktest", [{ recommendationId: advice.recommendation.id, startingBalance: 1000 }]);
    assert.equal(validation.ok, true);
    assert.equal(validation.outOfSample.validationBars, 300);
    assert.equal(validation.run.datasetHash, validation.baselineRun.datasetHash, "base and candidate share the exact validation dataset");
    assert.equal(validation.run.period.fromTs, validation.baselineRun.period.fromTs);
    assert.equal(validation.run.setup.settings.maxStakeUsd, validation.baselineRun.setup.settings.maxStakeUsd);
    assert.equal(validation.run.approximate, true);
    host.dispose();
    host = new ExecutionHost({ userDataDir: root, engineOptions: { market: { bars: [], on() {}, start() {}, stop() {} }, live: { configure() {} }, aiRequest: request } });
    const state = await host.call("aiStatus");
    assert.equal(state.recommendations[0].model, "fixture/mock");
    assert.equal(state.recommendations[0].status, "candidate_created");
    assert.ok(!JSON.stringify(state).includes("isolated-key"));
    assert.equal(host.engine.activeSetupSnapshot().id, base.id);
    console.log("AI candidate approval, baseline/holdout validation and restart tests ok");
  } finally { host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
