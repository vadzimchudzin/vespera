"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `renderer handler found: ${start}`);
  return source.slice(from, to);
};

function harness() {
  const timers = new Map();
  const calls = [];
  const fields = Object.fromEntries([
    ["base", "2.00"], ["steps", "6"], ["opening", "20"], ["crossTicks", "100"],
    ["confirms", "0"], ["fastPeriod", "20"], ["slowPeriod", "200"], ["refresh", "100"],
    ["maxStake", "25"], ["maxEntry", "100"], ["dailyLimit", "50"],
    ["notifyToggle", ""], ["fullBodyToggle", ""], ["saveSet", ""], ["settingsSaveError", ""],
  ].map(([id, value]) => [id, {
    value, disabled: false, hidden: true, isConnected: true, textContent: "",
    classList: { contains: () => false },
    scrollIntoView: () => {},
  }]));
  const context = {
    state: { savePatch: {}, planPatch: {}, savingPanel: false },
    window: { vespera: {
      saveSettings: async (patch) => {
        calls.push(JSON.parse(JSON.stringify(patch)));
        return { settings: patch };
      },
      confirmLot: async () => {},
    } },
    $: (id) => fields[id],
    s: {},
    body: { querySelectorAll: () => Object.values(fields) },
    foot: { querySelectorAll: () => [] },
    document: { querySelector: () => null },
    t: (key) => key,
    moneyOr: (el) => Number(el.value),
    paintPlan: () => {}, renderSnap: () => {}, hideTip: () => {},
    closePanel: () => { context.closed = true; },
    setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext([
    between("  function debounceSave(", "  function paintChromePicks("),
    between("      const planSave =", "      $(\"sizingSeg\").onclick"),
    between("      const saveNow =", "      if (foot) {"),
    "this.handlers = { debounceSave, planSave, saveNow };",
  ].join("\n"), context);
  return { context, fields, calls, timers, ...context.handlers };
}

(async () => {
  for (const name of ["debounceSave", "planSave"]) {
    const h = harness();
    h[name]({ minCrossTicks: 10 });
    h[name]({ minOpeningAtr: 1 });
    h[name]({ minCrossTicks: 100 });
    assert.strictEqual(h.timers.size, 1);
    await [...h.timers.values()][0]();
    assert.deepStrictEqual(h.calls, [{ minCrossTicks: 100, minOpeningAtr: 1 }]);
    h[name]({ confirmCount: 2 });
    await [...h.timers.values()].at(-1)();
    assert.deepStrictEqual(h.calls[1], { confirmCount: 2 }, "a new batch does not resend old edits");
  }

  const h = harness();
  h.debounceSave({ minCrossTicks: 10 });
  h.planSave({ maxStakeUsd: 5 });
  let rejectSave;
  h.context.window.vespera.saveSettings = () => new Promise((_, reject) => { rejectSave = reject; });
  const pending = h.saveNow();
  assert.strictEqual(h.context.closed, undefined);
  assert.strictEqual(h.fields.saveSet.textContent, "saving");
  assert.strictEqual(h.fields.saveSet.disabled, true);
  assert.strictEqual(h.timers.size, 0, "explicit Save supersedes queued autosaves");
  rejectSave(new Error("disk full"));
  await pending;
  assert.strictEqual(h.context.closed, undefined, "failed Save leaves the panel open");
  assert.strictEqual(h.fields.settingsSaveError.hidden, false);
  assert.strictEqual(h.fields.settingsSaveError.textContent, "saveFailed");
  assert.strictEqual(h.fields.maxStake.value, "25", "edits survive failure");
  assert.strictEqual(h.fields.saveSet.disabled, false, "retry is enabled");

  h.context.window.vespera.saveSettings = async (patch) => {
    h.calls.push(JSON.parse(JSON.stringify(patch)));
    return { settings: patch };
  };
  await h.saveNow();
  assert.strictEqual(h.context.closed, true, "successful retry closes the panel");
  assert.strictEqual(h.fields.settingsSaveError.hidden, true);
  assert.strictEqual(h.calls[0].maxStakeUsd, 25);
  assert.strictEqual(h.calls[0].minCrossTicks, 100);
  console.log("renderer settings tests ok");
})().catch((err) => { console.error(err); process.exitCode = 1; });
