"use strict";

// The agents desk asks the language model through the AI advisor: the same key, model and budget, OpenRouter only,
// every question priced at its worst case before it is sent, and never in the way of the user's own requests.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SetupStore } = require("../setupStore");
const { AIAdvisor } = require("../aiAdvisor");
const { AgentDesk } = require("./desk");

const NOW = Date.UTC(2026, 10, 4, 12);
const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";
const pricing = { data: [{ id: "vendor/model", pricing: { prompt: "0.0000001", completion: "0.0000002" }, context_length: 32768 }] };
const reply = (content, usage = { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.00012 }) => ({ choices: [{ message: { content } }], usage });
const respond = (value, status = 200) => ({ status, async text() { return JSON.stringify(value); } });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-agents-ai-"));
  const calls = [];
  let answer = reply(JSON.stringify({ forecasts: [] }));
  const request = async (url, payload, options) => {
    calls.push({ url, payload, options });
    return url.endsWith("/models") ? respond(pricing) : respond(answer);
  };
  const clock = { t: NOW };
  const advisor = new AIAdvisor({ root, setupStore: new SetupStore(path.join(root, "setups")), research: { store: { value: { runs: [] } } }, request, now: () => clock.t });

  assert.deepStrictEqual(advisor.agentsAvailable(), { ok: false, reason: "ai_disabled" });
  advisor.configure({ enabled: true, model: "vendor/model", dailyBudgetUsd: 0.1, maxRequestUsd: 0.01 });
  assert.deepStrictEqual(advisor.agentsAvailable(), { ok: false, reason: "ai_key_missing" });
  advisor.configure({ key: SECRET });
  assert.deepStrictEqual(advisor.agentsAvailable(), { ok: true, reason: null, model: "vendor/model" });
  await assert.rejects(advisor.agentQuery({ system: "s", prompt: "x".repeat(16 * 1024 + 1) }), /ai_prompt_too_large/);
  await assert.rejects(advisor.agentQuery({ system: "", prompt: "p" }), /ai_prompt_invalid/);
  assert.strictEqual(calls.length, 0, "refused before any request");

  const out = await advisor.agentQuery({ system: "Answer with JSON only.", prompt: "{\"markets\":[]}", maxTokens: 5000 });
  assert.deepStrictEqual(out, { content: "{\"forecasts\":[]}", costUsd: 0.00012, model: "vendor/model" });
  const chat = calls.find((c) => c.url.endsWith("/chat/completions"));
  assert.deepStrictEqual([chat.payload.max_tokens, chat.payload.response_format.type, chat.payload.messages[0].role, chat.payload.provider.require_parameters], [1024, "json_object", "system", true]);
  const near = (x) => Math.round(x * 1e9) / 1e9;
  assert.deepStrictEqual([near(chat.payload.provider.max_price.prompt), near(chat.payload.provider.max_price.completion)], [0.1, 0.2], "the provider cap is the model price per million tokens");
  assert.strictEqual(chat.options.headers.authorization, `Bearer ${SECRET}`);
  let status = advisor.status();
  assert.strictEqual(status.spentTodayUsd, 0.00012, "the reservation is settled at the reported cost");
  assert.strictEqual(advisor.state.lastRequestAt, 0, "the desk does not hold up the user's recommendation");
  assert.ok(!JSON.stringify(status).includes(SECRET));

  await advisor.agentQuery({ system: "s", prompt: "p", maxTokens: 1 });
  assert.strictEqual(calls.filter((c) => c.url.endsWith("/models")).length, 1, "prices are kept for an hour");
  assert.strictEqual(calls[calls.length - 1].payload.max_tokens, 64);

  answer = reply("not json", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.00001 });
  assert.strictEqual((await advisor.agentQuery({ system: "s", prompt: "p" })).content, "not json", "the desk checks the reply itself");
  answer = { choices: [] };
  const before = advisor.status().spentTodayUsd;
  await assert.rejects(advisor.agentQuery({ system: "s", prompt: "p" }), /ai_response_invalid/);
  assert.ok(advisor.status().spentTodayUsd > before, "an unreported cost stays charged at the worst case");

  advisor.configure({ maxRequestUsd: 0.001 });
  await assert.rejects(advisor.agentQuery({ system: "s", prompt: "p", maxTokens: 1024 }), /ai_budget_exceeded/);
  advisor.configure({ maxRequestUsd: 0.002, dailyBudgetUsd: 0.003 });
  assert.ok(advisor.status().spentTodayUsd + 0.0018 > 0.003, "the day is nearly spent");
  await assert.rejects(advisor.agentQuery({ system: "s", prompt: "p" }), /ai_budget_exceeded/);
  advisor.configure({ provider: "local", model: "qwen2.5:1.5b" });
  assert.deepStrictEqual(advisor.agentsAvailable(), { ok: false, reason: "ai_agents_openrouter_only" });

  // the desk sees the advisor's verdict
  const desk = new AgentDesk({ root: path.join(root, "agents"), ai: advisor, now: () => clock.t, autoTick: false, net: { json: async () => [], text: async () => "" } });
  assert.deepStrictEqual([desk.status().ai.available, desk.status().ai.reason], [false, "ai_agents_openrouter_only"]);
  advisor.configure({ provider: "openrouter", model: "vendor/model", dailyBudgetUsd: 1 });
  assert.strictEqual(desk.status().ai.available, true);
  desk.dispose();

  fs.rmSync(root, { recursive: true, force: true });
  console.log("agents ai bridge tests ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
