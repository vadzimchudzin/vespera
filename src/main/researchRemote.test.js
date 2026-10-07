"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExecutionHost } = require("./executionHost");
const { ExecutionRouter } = require("./executionRouter");
const { createService } = require("../server/service");

const roots = [];
function dir() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-research-http-")); roots.push(value); return value; }
function options() {
  return { market: { bars: [], on() { return () => {}; }, start() {}, stop() {}, async loadHistory() {} },
    live: { configure() {}, async marketBuy() { assert.fail("research must never reach live broker"); } },
    researchMarketFactory: ({ symbol, timeframe }) => ({ symbol, timeframe, bars: [],
      on() { return () => {}; }, start() {}, stop() {},
      async loadHistory() { return this.bars; },
    }),
  };
}
async function run() {
  const localRoot = dir();
  const host = new ExecutionHost({ userDataDir: localRoot, engineOptions: options() });
  const router = new ExecutionRouter({ userDataDir: localRoot, host, pollMs: 100000 });
  const token = "research-test-token-" + "a".repeat(40);
  const service = createService({ userDataDir: dir(), token, hostFactory: (input) => new ExecutionHost({ ...input, engineOptions: options() }) });
  try {
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    await router.configure({ url: `http://127.0.0.1:${service.server.address().port}`, token });
    const setup = await router.dispatch("saveSetup", [{ name: "Paper HTTP experiment" }]);
    assert.equal((await router.switchMode("server")).ok, true);
    const started = await router.dispatch("startPaperRuns", [{ setups: [{ id: setup.setup.id, version: 1 }], startingBalance: "1000.00" }]);
    assert.equal(started.ok, true);
    const status = await router.dispatch("researchStatus");
    assert.equal(status.runs.length, 1);
    assert.equal(status.runs[0].running, true);
    const refused = await router.switchMode("local");
    assert.equal(refused.ok, false, "active experiments block execution handoff");
    assert.equal(service.owner.owner, "server");
    assert.equal((await router.dispatch("researchStatus")).runs[0].running, true, "refused handoff does not stop another user's experiment");
    const report = await router.dispatch("researchReport", [{ period: "week" }]);
    assert.equal(report.ok, true);
    const exported = await router.dispatch("exportResearch", [{ period: "week" }]);
    assert.equal(exported.ok, true);
    assert.ok(!exported.csv.includes(token));
    await router.dispatch("stopPaperRun", [{ id: status.runs[0].id }]);
    assert.equal((await router.switchMode("local")).ok, true);
    assert.equal((await router.dispatch("researchStatus")).runs.length, 0, "executor-specific experiments are not cloned on handoff");
    console.log("Paper research HTTP ownership tests ok");
  } finally {
    router.dispose();
    await service.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
