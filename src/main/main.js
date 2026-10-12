"use strict";

const { app, BrowserWindow, ipcMain, shell, Notification, dialog, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const { ExecutionRouter } = require("./executionRouter");

let win;
let router;

if (!app.requestSingleInstanceLock()) app.exit(0);

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 720,
    backgroundColor: "#161514", title: "Vespera",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 18 }, frame: process.platform === "darwin",
    autoHideMenuBar: true, icon: path.join(__dirname, "../../build/icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  // Only https links ever leave the app; the window itself never navigates away from the bundled UI.
  const safeExternal = (value) => { try { return new URL(value).protocol === "https:"; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => { if (safeExternal(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (safeExternal(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  router = new ExecutionRouter({
    userDataDir: app.getPath("userData"),
    onEvent: (evt) => {
      if (win && !win.isDestroyed()) win.webContents.send("engine:event", evt);
      if (evt.type === "notify" && evt.payload && Notification.isSupported()) {
        new Notification({ title: evt.payload.title || "Vespera", body: evt.payload.body || "", silent: false }).show();
      }
    },
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      router.syncTelegram();
      router.syncResearch();
    }
  });
});
app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
app.on("window-all-closed", () => {
  // Disposing a UI client never sends Stop to the server.
  if (router) {
    router.host.setTelegramContext?.({ active: false })?.catch(() => {});
    Promise.resolve(router.host.setResearchContext?.({ active: false })).catch(() => {});
    router.host.engine.stop();
    router.host.engine.market.stop?.();
  }
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => router?.dispose());

const ROUTES = {
  "ai:status": "aiStatus", "ai:configure": "aiConfigure", "ai:models": "aiModels",
  "ai:recommend": "aiRecommend", "ai:candidate": "aiCreateSetup", "ai:backtest": "aiBacktest", "ai:pull": "aiLocalPull",
  "research:status": "researchStatus", "research:backtest": "runBacktest",
  "research:start": "startPaperRuns", "research:stop": "stopPaperRun", "research:report": "researchReport",
  "setups:list": "listSetups", "setups:save": "saveSetup",
  "setups:apply": "applySetup", "setups:copy": "copySetup",
  "risk:inspectOrder": "inspectPendingOrder", "risk:resolveOrder": "resolvePendingOrder",
  "risk:finalSettlement": "reconcileFinalSettlement",
  "engine:snapshot": "snapshot", "engine:warmChart": "warmChart", "engine:start": "start",
  "engine:stop": "stop", "engine:setMode": "setMode", "engine:confirmLot": "confirmLot",
  "engine:ping": "ping", "engine:connect": "connect", "engine:testOrder": "testOrder",
  "engine:deriveKeys": "deriveKeys", "engine:setStrategy": "setStrategy", "engine:resetPaper": "resetPaper",
  "settings:get": "getSettings", "settings:save": "saveSettings",
  "telegram:status": "telegramStatus", "telegram:configure": "telegramConfigure",
  "telegram:pair": "telegramPair", "telegram:test": "telegramTest", "telegram:disconnect": "telegramDisconnect",
  "deposit:assets": "depositAssets", "deposit:address": "depositAddress", "deposit:status": "depositStatus",
};
for (const [channel, method] of Object.entries(ROUTES)) {
  ipcMain.handle(channel, (_e, ...args) => router.dispatch(method, args));
}
ipcMain.handle("research:export", async (_e, input) => {
  const result = await router.dispatch("exportResearch", [input || {}]);
  if (!result?.ok || !result.count) return result;
  const pick = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), "vespera-paper-research.csv"), filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (pick.canceled || !pick.filePath) return { ok: false, reason: "cancelled" };
  fs.writeFileSync(pick.filePath, result.csv, { encoding: "utf8", mode: 0o600 });
  return { ok: true, count: result.count };
});
ipcMain.handle("setups:import", async () => {
  const pick = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Vespera setup JSON", extensions: ["json"] }] });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, reason: "cancelled" };
  const fd = fs.openSync(pick.filePaths[0], "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size > 256 * 1024) return { ok: false, reason: "setup_import_too_large" };
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > 256 * 1024) return { ok: false, reason: "setup_import_too_large" };
    const json = buffer.subarray(0, bytes).toString("utf8");
    return await router.dispatch("importSetup", [{ json }]);
  } finally { fs.closeSync(fd); }
});
ipcMain.handle("setups:export", async (_e, input) => {
  const result = await router.dispatch("exportSetup", [input || {}]);
  if (!result?.ok) return result;
  const safeName = String(result.name || "vespera-setup").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 80);
  const pick = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), `${safeName}.json`), filters: [{ name: "Vespera setup JSON", extensions: ["json"] }] });
  if (pick.canceled || !pick.filePath) return { ok: false, reason: "cancelled" };
  fs.writeFileSync(pick.filePath, result.json, { encoding: "utf8", mode: 0o600 });
  return { ok: true };
});
ipcMain.handle("execution:get", async () => { await router.poll(); return router.execution(); });
ipcMain.handle("execution:configure", async (_e, patch) => {
  try { return await router.configure(patch); }
  catch (err) { return { ok: false, reason: err.code || "remote_unavailable", execution: router.execution() }; }
});
ipcMain.handle("execution:setMode", (_e, mode) => router.switchMode(mode));

ipcMain.handle("journal:exportCsv", async () => {
  const { csv, count } = await router.dispatch("exportCsv");
  if (!count) return { ok: false, reason: "empty" };
  const day = new Date().toISOString().slice(0, 10);
  const pick = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath("documents"), `vespera-trades-${day}.csv`),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false, reason: "cancelled" };
  fs.writeFileSync(pick.filePath, csv, "utf8");
  return { ok: true, count };
});
ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(String(text || "")); return true; });
ipcMain.handle("window:minimize", () => win.minimize());
ipcMain.handle("window:close", () => win.close());
ipcMain.handle("window:maximize", () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
