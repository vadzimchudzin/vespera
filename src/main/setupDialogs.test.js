"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vespera-setup-dialogs-"));
  const handlers = new Map();
  const calls = [];
  let openPick = { canceled: true, filePaths: [] };
  let savePick = { canceled: true };
  let saveOptions;
  const mainPath = path.join(__dirname, "main.js");
  const nativeRequire = createRequire(mainPath);
  const dialog = {
    async showOpenDialog() { return openPick; },
    async showSaveDialog(_win, options) { saveOptions = options; return savePick; },
  };
  const electron = {
    app: { requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), on() {}, getPath: () => dir },
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    dialog,
  };
  const router = { async dispatch(method, args) {
    calls.push({ method, args });
    if (method === "exportSetup") return { ok: true, name: "../BTC / first", json: '{"schemaVersion":1}' };
    if (method === "exportResearch") return { ok: true, csv: "run_id,pnl\r\nvirtual,1.25\r\n", count: 1 };
    return { ok: true };
  } };
  try {
    vm.runInNewContext(fs.readFileSync(mainPath, "utf8") + "\nrouter = injectedRouter;", {
      require: (name) => name === "electron" ? electron : nativeRequire(name), injectedRouter: router,
      __dirname, process, console, Buffer,
    });
    assert.equal((await handlers.get("setups:import")()).reason, "cancelled");
    assert.equal(calls.length, 0);
    const file = path.join(dir, "portable.json");
    fs.writeFileSync(file, '{"schemaVersion":1,"name":"isolated"}');
    openPick = { canceled: false, filePaths: [file] };
    assert.equal((await handlers.get("setups:import")()).ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { method: "importSetup", args: [{ json: fs.readFileSync(file, "utf8") }] });
    fs.writeFileSync(file, "x".repeat(256 * 1024 + 1));
    const before = calls.length;
    assert.equal((await handlers.get("setups:import")()).reason, "setup_import_too_large");
    assert.equal(calls.length, before, "large profile cannot reach the import API");
    assert.equal((await handlers.get("setups:export")(null, { id: "id", version: 1 })).reason, "cancelled");
    assert.equal(path.dirname(saveOptions.defaultPath), dir, "suggested name cannot escape Documents");
    savePick = { canceled: false, filePath: path.join(dir, "export.json") };
    assert.equal((await handlers.get("setups:export")(null, { id: "id", version: 1 })).ok, true);
    assert.equal(fs.readFileSync(savePick.filePath, "utf8"), '{"schemaVersion":1}');
    savePick = { canceled: false, filePath: path.join(dir, "research.csv") };
    assert.equal((await handlers.get("research:export")(null, { period: "week" })).ok, true);
    assert.equal(fs.readFileSync(savePick.filePath, "utf8"), "run_id,pnl\r\nvirtual,1.25\r\n");
    console.log("Setup native dialog tests ok");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
