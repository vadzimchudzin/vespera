"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SetupStore } = require("./setupStore");
const { AIAdvisor, safeLocalUrl } = require("./aiAdvisor");

const NOW = Date.UTC(2026, 0, 10, 12);
const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";
const settings = {
  strategyId: "sma200_20", symbol: "BTCUSDT", timeframe: "15m", maType: "SMA",
  fastPeriod: 20, slowPeriod: 200, minOpeningAtr: 0, minCrossTicks: 0,
  confirmCount: 0, fullBodyOnS: false, sizingMode: "double", fixedStakes: [1, 2, 4, 8, 16, 32],
  baseUsd: "1.00", maxSteps: 6, maxStakeUsd: 0, maxSeriesLossUsd: 0, dailyLossLimitUsd: 0, maxEntryPrice: 1,
};
const pricing = { data: [{ id: "vendor/model", pricing: { prompt: 0.0000001, completion: 0.0000002 }, context_length: 32768 }] };
const answer = { choices: [{ message: { content: JSON.stringify({ explanation: "Consider a slightly shorter fast average.", patch: { fastPeriod: 24 } }) } }],
  usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, cost: 0.0005 } };

const roots = [];
function fixture({ responder, direct = false, root: existingRoot } = {}) {
  const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), "vespera-ai-"));
  roots.push(root);
  const setups = new SetupStore(path.join(root, "setups"));
  const saved = setups.saveSetup({ name: "Research seed", settings });
  const calls = [];
  const request = async (url, payload, options) => {
    calls.push({ url, payload, options });
    if (responder) return responder(url, payload, options);
    return { status: 200, async text() {
      return url.endsWith("/models") ? JSON.stringify(pricing) : JSON.stringify(answer);
    } };
  };
  const research = { store: { value: { runs: [] } } };
  const advisor = new AIAdvisor({ root, setupStore: setups, research, request, direct, now: () => NOW });
  return { root, setups, saved, calls, advisor };
}

function response(value, status = 200) { return { status, async text() { return typeof value === "string" ? value : JSON.stringify(value); } }; }

async function run() {
  assert.throws(() => safeLocalUrl("https://127.0.0.1:11434"), /ai_local_url_denied/);
  assert.throws(() => safeLocalUrl("http://example.com"), /ai_local_url_denied/);
  assert.throws(() => safeLocalUrl("http://127.0.0.1.attacker.test"), /ai_local_url_denied/);
  assert.equal(safeLocalUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");

  const base = fixture();
  let status = base.advisor.status();
  assert.equal(status.config.enabled, false, "advisory is disabled by default");
  assert.equal(status.hasKey, false);
  await assert.rejects(base.advisor.recommend({ id: base.saved.id, version: 1 }), /ai_disabled/);
  base.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 0.1, maxRequestUsd: 0.01 });
  status = base.advisor.status();
  assert.equal(status.hasKey, true);
  assert.equal(Object.hasOwn(status, "apiKey"), false);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  const encrypted = fs.readFileSync(path.join(base.root, "ai-private", "settings.json"), "utf8");
  assert.equal(encrypted.includes(SECRET), false);

  const result = await base.advisor.recommend({ id: base.saved.id, version: 1 });
  assert.equal(result.recommendation.status, "proposed");
  assert.equal(result.recommendation.model, "vendor/model");
  assert.deepEqual(result.recommendation.patch, { fastPeriod: 24 });
  assert.ok(base.advisor.status().spentTodayUsd <= 0.001, "authoritative provider usage releases unused reservation");
  assert.equal(base.calls[1].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(base.calls[1].payload.max_tokens, 512);
  assert.ok(base.calls[1].payload.provider.max_price.prompt >= 0);
  assert.equal(JSON.stringify(base.advisor.status()).includes(SECRET), false);
  await assert.rejects(base.advisor.recommend({ id: base.saved.id, version: 1 }), /ai_recommendation_exists/);

  const insufficient = fixture({ responder: async (url) => response(url.endsWith("/models") ? {
    data: [{ id: "vendor/model", pricing: { prompt: 0.00001, completion: 0.00001 }, context_length: 32768 }],
  } : answer) });
  insufficient.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 0.01, maxRequestUsd: 0.01 });
  await assert.rejects(insufficient.advisor.recommend({ id: insufficient.saved.id, version: 1 }), /ai_budget_exceeded/);
  assert.equal(insufficient.calls.some((call) => call.url.endsWith("/chat/completions")), false, "budget is checked before paid requests");
  assert.equal(insufficient.advisor.status().spentTodayUsd, 0);
  const free = fixture({ responder: async (url) => response(url.endsWith("/models") ? {
    data: [{ id: "vendor/model", pricing: { prompt: "0", completion: "0" }, context_length: 32768 }],
  } : { ...answer, usage: { ...answer.usage, cost: 0 } }) });
  free.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 0, maxRequestUsd: 0 });
  assert.equal((await free.advisor.recommend({ id: free.saved.id, version: 1 })).ok, true, "verified free routing honors a zero budget");
  assert.equal(free.advisor.status().spentTodayUsd, 0);

  for (const invalidContent of [
    "not json",
    JSON.stringify({ explanation: "risk lift", patch: { maxStakeUsd: 1000 } }),
    JSON.stringify({ explanation: "risk lift", patch: { fastPeriod: 25, dailyLossLimitUsd: 999999 } }),
    JSON.stringify({ explanation: "x", patch: { fastPeriod: 1000 } }),
    JSON.stringify({ explanation: SECRET, patch: {} }),
    JSON.stringify({ explanation: "ok", patch: {}, extra: true }),
  ]) {
    const broken = fixture({ responder: async (url) => response(url.endsWith("/models") ? pricing : {
      choices: [{ message: { content: invalidContent } }], usage: { cost: 0.0001 },
    }) });
    broken.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 0.1, maxRequestUsd: 0.01 });
    await assert.rejects(broken.advisor.recommend({ id: broken.saved.id, version: 1 }));
    const safe = broken.advisor.status();
    assert.equal(JSON.stringify(safe).includes(SECRET), false);
    assert.equal(safe.recommendations[0].explanation, "");
    assert.deepEqual(safe.recommendations[0].patch, {});
  }

  const timeout = fixture({ responder: async (url, _payload, options) => {
    if (url.endsWith("/models")) return response(pricing);
    const error = new Error("aborted"); error.name = "AbortError";
    assert.equal(options.timeoutMs, 1000);
    throw error;
  } });
  timeout.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 0.1, maxRequestUsd: 0.01, timeoutMs: 1000 });
  await assert.rejects(timeout.advisor.recommend({ id: timeout.saved.id, version: 1 }), /ai_timeout/);
  assert.ok(timeout.advisor.status().spentTodayUsd > 0, "lost responses keep their durable budget reservation");
  assert.equal(timeout.advisor.status().busy, false);

  const concurrent = fixture({ responder: async (url) => {
    if (url.endsWith("/models")) return response(pricing);
    await new Promise((resolve) => { concurrent.release = resolve; });
    return response(answer);
  } });
  concurrent.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 0.1, maxRequestUsd: 0.01 });
  const pending = concurrent.advisor.recommend({ id: concurrent.saved.id, version: 1 });
  while (!concurrent.release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(concurrent.advisor.recommend({ id: concurrent.saved.id, version: 1 }), /ai_busy/);
  concurrent.release();
  await pending;

  const local = fixture({ responder: async (url) => {
    if (url.endsWith("/api/tags")) return response({ models: [{ name: "qwen2.5:1.5b", size: 1_000_000_000, digest: `sha256:${"a".repeat(64)}` }] });
    if (url.endsWith("/api/show")) return response({ license: "Apache License\nVersion 2.0" });
    if (url.endsWith("/api/chat")) return response({ message: { content: JSON.stringify({ explanation: "Local advisory.", patch: { maType: "EMA" } }) } });
    throw new Error("unexpected local endpoint");
  } });
  local.advisor.localHardware = () => ({ eligible: true, memoryBytes: 5e9, availableDiskBytes: 5e9 });
  local.advisor.configure({ provider: "local", model: "qwen2.5:1.5b", enabled: true });
  const localResult = await local.advisor.recommend({ id: local.saved.id, version: 1 });
  assert.equal(localResult.recommendation.validation.license, "Apache-2.0");
  assert.equal(localResult.recommendation.validation.digestSource.includes("not independently verified"), true);
  assert.equal(local.advisor.status().hasKey, false, "local mode never needs the OpenRouter key");

  const noDigest = fixture({ responder: async (url) => url.endsWith("/api/tags")
    ? response({ models: [{ name: "qwen2.5:1.5b", digest: "unknown" }] })
    : response({ license: "Apache License Version 2.0" }) });
  noDigest.advisor.localHardware = () => ({ eligible: true });
  noDigest.advisor.configure({ provider: "local", model: "qwen2.5:1.5b", enabled: true });
  await assert.rejects(noDigest.advisor.recommend({ id: noDigest.saved.id, version: 1 }), /ai_local_digest_invalid/);
  const oversized = fixture({ responder: async () => response({ models: [{ name: "qwen2.5:1.5b", digest: "a".repeat(64), size: 3 * 1024 ** 3 }] }) });
  oversized.advisor.localHardware = () => ({ eligible: true });
  oversized.advisor.configure({ provider: "local", model: "qwen2.5:1.5b", enabled: true });
  await assert.rejects(oversized.advisor.recommend({ id: oversized.saved.id, version: 1 }), /ai_local_size_unverified/);

  const overcharge = fixture({ responder: async (url) => response(url.endsWith("/models") ? pricing : { ...answer, usage: { ...answer.usage, cost: 0.5 } }) });
  overcharge.advisor.configure({ enabled: true, model: "vendor/model", key: SECRET, dailyBudgetUsd: 1, maxRequestUsd: 0.01 });
  await overcharge.advisor.recommend({ id: overcharge.saved.id, version: 1 });
  assert.equal(overcharge.advisor.status().config.enabled, false, "unexpected provider charge disables further recommendations");
  assert.ok(overcharge.advisor.status().spentTodayUsd >= 0.5, "charge is not hidden behind a smaller reservation");

  assert.throws(() => local.advisor.configure({ localUrl: "http://192.168.1.3:11434" }), /ai_local_url_denied/);
  const server = fixture({ direct: true });
  assert.doesNotThrow(() => server.advisor.configure({ enabled: true, key: SECRET }));
  assert.throws(() => server.advisor.configure({ provider: "local" }), /ai_local_desktop_only/);

  const reopened = fixture({ root: base.root });
  assert.equal(reopened.advisor.status().hasKey, true, "encrypted AI key survives reopen in its dedicated scope");
  console.log("AI advisor tests ok");
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
