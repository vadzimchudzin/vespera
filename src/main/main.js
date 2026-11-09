"use strict";

const { app, BrowserWindow, ipcMain, shell, Notification, dialog, clipboard, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { ExecutionRouter } = require("./executionRouter");
const { chromiumProxy } = require("./agents/proxy");

let win;
let router;
let ringWin = null;
let ringTimer = null;
let ringOpening = null;

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
  win.on("closed", () => { if (ringWin && !ringWin.isDestroyed()) ringWin.close(); });
}

// The ring reads Polymarket from Chromium, so it gets the proxy from the API panel in a session of its own; the main
// window's session is left alone. Chromium cannot log in to a SOCKS proxy, so with a SOCKS proxy that has a login the
// ring does not open rather than go direct.
async function ringSession() {
  const cfg = chromiumProxy(router?.host?.outboundProxy?.() || "");
  if (!cfg.ok) return cfg;
  const ses = session.fromPartition("vespera-ring");
  await ses.setProxy(cfg.rules ? { proxyRules: cfg.rules, proxyBypassRules: "<local>" } : { mode: "system" });
  if (typeof ses.closeAllConnections === "function") await ses.closeAllConnections();   // nothing left on the old route
  return { ok: true, ses, auth: cfg.auth };
}

// The ring (tools/engine-viz) in its own window: the live Polymarket picture plus a read-only feed of the agents'
// paper positions. It never gets the main preload, so it cannot reach the engine, settings or keys.
function openRing() {
  if (ringWin && !ringWin.isDestroyed()) {
    if (ringWin.isMinimized()) ringWin.restore();
    ringWin.show();
    ringWin.focus();
    return { ok: true };
  }
  if (!ringOpening) ringOpening = createRing().finally(() => { ringOpening = null; });
  return ringOpening;
}

async function createRing() {
  const net = await ringSession();
  if (!net.ok) return { ok: false, reason: net.reason };
  ringWin = new BrowserWindow({
    width: 1600, height: 960, minWidth: 960, minHeight: 600, backgroundColor: "#060607", title: "Vespera · Ring",
    autoHideMenuBar: true, icon: path.join(__dirname, "../../build/icon.png"),
    webPreferences: { preload: path.join(__dirname, "ringPreload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, session: net.ses },
  });
  const page = ringWin;
  // the proxy's login, at most three answers a minute: a wrong password ends in a refusal, not a loop
  const answers = [];
  page.webContents.on("login", (event, _details, authInfo, callback) => {
    const t = Date.now();
    while (answers.length && t - answers[0] > 60000) answers.shift();
    if (!authInfo || !authInfo.isProxy || !net.auth || answers.length >= 3) return;
    event.preventDefault();
    answers.push(t);
    callback(net.auth.username, net.auth.password);
  });
  page.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  page.webContents.on("will-navigate", (event, url) => { if (url !== page.webContents.getURL()) event.preventDefault(); });
  page.loadFile(path.join(__dirname, "../../tools/engine-viz/index.html"));
  let busy = false;
  const push = async () => {
    if (busy || page.isDestroyed()) return;
    busy = true;
    try {
      const data = await router.dispatch("agentsRing");
      if (!page.isDestroyed()) page.webContents.send("ring:agents", data);
    } catch { /* the ring keeps its last picture */ } finally { busy = false; }
  };
  page.webContents.on("did-finish-load", push);
  clearInterval(ringTimer);
  ringTimer = setInterval(push, 3000);
  page.on("closed", () => {
    if (ringWin === page) { clearInterval(ringTimer); ringTimer = null; ringWin = null; }
  });
  return { ok: true };
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
  "agents:status": "agentsStatus", "agents:configure": "agentsConfigure", "agents:start": "agentsStart",
  "agents:stop": "agentsStop", "agents:kill": "agentsKill", "agents:resume": "agentsResume",
  "agents:agent": "agentsAgent", "agents:report": "agentsReport", "agents:ring": "agentsRing", "agents:reset": "agentsReset",
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
ipcMain.handle("ring:open", () => openRing());
// The V2 lanes' files on this computer (ledgers, certificates, trade logs) in the system's file manager.
ipcMain.handle("agents:openData", async () => {
  const dir = path.join(app.getPath("userData"), "agents", "lanes");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { ok: false, reason: "agents_store_unwritable" }; }
  const error = await shell.openPath(dir);
  return error ? { ok: false, reason: "agents_open_failed" } : { ok: true };
});
ipcMain.handle("execution:get", async () => { await router.poll(); return router.execution(); });
ipcMain.handle("execution:configure", async (_e, patch) => {
  try { return await router.configure(patch); }
  catch (err) { return { ok: false, reason: err.code || "remote_unavailable", execution: router.execution() }; }
});
ipcMain.handle("execution:resetCredential", () => router.getResetCredential());
ipcMain.handle("execution:resetAccess", async (_e, input) => {
  try { return await router.resetAccess(input); }
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
