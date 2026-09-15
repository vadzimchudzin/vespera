"use strict";

const { app, BrowserWindow, ipcMain, shell, Notification } = require("electron");
const path = require("path");
const { Engine } = require("./engine");
const { SettingsStore } = require("./settingsStore");

let win;
let engine;
let store;

process.on("uncaughtException", (err) => {
  const msg = String((err && err.message) || err);
  if (/WebSocket was closed before the connection was established/i.test(msg)) return;
  console.error(err);
});
process.on("unhandledRejection", (err) => {
  const msg = String((err && err.message) || err);
  if (/WebSocket was closed before the connection was established/i.test(msg)) return;
  console.error(err);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#161514",
    title: "Vespera",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    frame: process.platform === "darwin",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function push(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  store = new SettingsStore(app.getPath("userData"));
  engine = new Engine({
    userDataDir: app.getPath("userData"),
    settings: store.value,
  });
  engine.on((evt) => {
    push("engine:event", evt);
    if (evt.type === "notify" && evt.payload && Notification.isSupported()) {
      const n = new Notification({
        title: evt.payload.title || "Vespera",
        body: evt.payload.body || "",
        silent: false,
      });
      n.show();
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (engine) {
    engine.stop();
    if (engine.market && typeof engine.market.stop === "function") engine.market.stop();
  }
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("engine:snapshot", () => engine.snapshot());
ipcMain.handle("engine:warmChart", () => engine.warmChart());
ipcMain.handle("engine:start", () => engine.start());
ipcMain.handle("engine:stop", () => engine.stop());
ipcMain.handle("engine:setMode", async (_e, mode) => {
  await engine.setMode(mode);
  store.save({ mode: engine.mode });
  return engine.snapshot();
});
ipcMain.handle("engine:confirmLot", (_e, baseUsd) => {
  store.save({ baseUsd });
  engine.confirmLot(baseUsd);
  return engine.snapshot();
});
ipcMain.handle("engine:ping", (_e, apiKey) => {
  store.save({ apiKey });
  return engine.pingApi(apiKey);
});
ipcMain.handle("engine:setStrategy", (_e, id) => {
  const result = engine.setStrategy(id);
  if (result.ok) store.save({ strategyId: result.strategyId });
  return { ...result, state: engine.snapshot() };
});
ipcMain.handle("engine:resetPaper", (_e, startingBalance) => {
  const snap = engine.resetPaper(startingBalance);
  store.save({ paperBalance: engine.paper.startingBalance.toFixed(2) });
  return snap;
});
ipcMain.handle("settings:get", () => store.value);
ipcMain.handle("settings:save", async (_e, patch) => {
  const next = store.save(patch);
  await engine.applySettings(patch);
  return next;
});
ipcMain.handle("window:minimize", () => win.minimize());
ipcMain.handle("window:close", () => win.close());
ipcMain.handle("window:maximize", () => {
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
