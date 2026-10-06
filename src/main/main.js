"use strict";

const { app, BrowserWindow, ipcMain, shell, Notification, dialog, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const { ExecutionRouter } = require("./executionRouter");

let win;
let router;

if (!app.requestSingleInstanceLock()) app.quit();

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
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
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
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
app.on("window-all-closed", () => {
  // Disposing a UI client never sends Stop to the server.
  router?.host.dispose();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => router?.dispose());

const ROUTES = {
  "engine:snapshot": "snapshot", "engine:warmChart": "warmChart", "engine:start": "start",
  "engine:stop": "stop", "engine:setMode": "setMode", "engine:confirmLot": "confirmLot",
  "engine:ping": "ping", "engine:connect": "connect", "engine:testOrder": "testOrder",
  "engine:deriveKeys": "deriveKeys", "engine:setStrategy": "setStrategy", "engine:resetPaper": "resetPaper",
  "settings:get": "getSettings", "settings:save": "saveSettings",
  "deposit:assets": "depositAssets", "deposit:address": "depositAddress", "deposit:status": "depositStatus",
};
for (const [channel, method] of Object.entries(ROUTES)) {
  ipcMain.handle(channel, (_e, ...args) => router.dispatch(method, args));
}
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
