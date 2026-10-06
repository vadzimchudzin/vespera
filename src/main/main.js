"use strict";

const { app, BrowserWindow, ipcMain, shell, Notification, dialog, clipboard } = require("electron");
const fs = require("fs");
const QRCode = require("qrcode");
const { toCsv } = require("./stats");
const path = require("path");
const { Engine } = require("./engine");
const { SettingsStore } = require("./settingsStore");
const { BridgeClient } = require("./brokers/bridge");
const { setProxy } = require("./brokers/clobClient");

let win;
let engine;
let store;
const bridge = new BridgeClient();

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
ipcMain.handle("engine:start", (_e, opts) => engine.start(opts || {}));
ipcMain.handle("engine:stop", () => engine.stop());
ipcMain.handle("engine:setMode", async (_e, mode) => {
  await engine.setMode(mode);
  // Auto may have moved the pair/timeframe onto a Polymarket round
  store.save({ mode: engine.mode, symbol: engine.settings.symbol, timeframe: engine.settings.timeframe });
  return engine.snapshot();
});
ipcMain.handle("engine:confirmLot", (_e, baseUsd, opts) => {
  engine.confirmLot(baseUsd, opts);
  store.save({ baseUsd: engine.settings.baseUsd });
  return engine.snapshot();
});
ipcMain.handle("engine:ping", (_e, creds) => {
  const patch = typeof creds === "string" ? { apiKey: creds } : creds || {};
  // Empty inputs keep whatever is already stored (the panel never shows a saved secret).
  const save = {};
  for (const key of ["apiKey", "apiSecret", "apiPassphrase", "privateKey"]) {
    if (patch[key] != null && String(patch[key]) !== "") save[key] = patch[key];
  }
  if (patch.walletAddress != null) save.walletAddress = patch.walletAddress;
  if (patch.proxyUrl != null) save.proxyUrl = patch.proxyUrl;
  if (patch.walletType != null) save.walletType = patch.walletType;
  store.save(save);
  return engine.pingApi(patch);
});
ipcMain.handle("engine:connect", async (_e, patch) => {
  const p = patch || {};
  const save = {};
  for (const key of ["apiKey", "apiSecret", "apiPassphrase", "privateKey"]) {
    if (p[key] != null && String(p[key]).trim() !== "") save[key] = String(p[key]).trim();
  }
  for (const key of ["walletAddress", "walletType", "proxyUrl"]) {
    if (p[key] != null) save[key] = String(p[key]).trim();
  }
  store.save(save);
  const res = await engine.connect(p);
  if (res.credentials) store.save(res.credentials);
  // secrets stay in the main process
  const { credentials, ...safe } = res;
  return safe;
});
ipcMain.handle("engine:testOrder", (_e, opts) => engine.testOrder(opts || {}));
ipcMain.handle("engine:deriveKeys", async (_e, patch) => {
  const p = patch || {};
  const save = {};
  if (p.privateKey != null && String(p.privateKey) !== "") save.privateKey = p.privateKey;
  if (p.walletAddress != null) save.walletAddress = p.walletAddress;
  if (p.walletType != null) save.walletType = p.walletType;
  if (p.proxyUrl != null) save.proxyUrl = p.proxyUrl;
  store.save(save);
  const res = await engine.deriveApiKeys(p);
  if (res.ok) {
    store.save({
      apiKey: res.apiKey,
      apiSecret: res.apiSecret,
      apiPassphrase: res.apiPassphrase,
    });
  }
  // never hand the secrets back to the window
  return {
    ok: res.ok,
    reason: res.reason || null,
    status: res.status || null,
    signerAddress: res.signerAddress || null,
    walletType: res.walletType || null,
  };
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
// Secrets stay in the main process; the window only learns whether they exist.
ipcMain.handle("journal:exportCsv", async () => {
  const { csv, count } = toCsv(engine.journal.readAll());
  if (!count) return { ok: false, reason: "empty" };
  const day = new Date().toISOString().slice(0, 10);
  const pick = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath("documents"), `vespera-trades-${day}.csv`),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false, reason: "canceled" };
  try {
    fs.writeFileSync(pick.filePath, csv, "utf8");
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
  return { ok: true, count, path: pick.filePath };
});
ipcMain.handle("settings:get", () => {
  const { apiKey, apiSecret, apiPassphrase, privateKey, ...safe } = store.value;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey),
    hasApiSecret: Boolean(apiSecret),
    hasApiPassphrase: Boolean(apiPassphrase),
    hasPrivKey: Boolean(privateKey),
  };
});
ipcMain.handle("settings:save", async (_e, patch) => {
  const p = patch || {};
  try {
    await engine.applySettings(p);
  } catch (err) {
    if (err.code === "invalid_settings" || err.code === "settings_locked") {
      return { ok: false, reason: err.code, field: err.field || null, message: err.message, state: engine.snapshot() };
    }
    throw err;
  }
  // persist what the engine accepted (Auto refuses pairs without a Polymarket round)
  const accepted = { ...p };
  for (const key of Object.keys(accepted)) {
    if (key in engine.settings) accepted[key] = engine.settings[key];
  }
  for (const key of ["baseUsd", "maxSteps", "fixedStakes", "fastPeriod", "slowPeriod"]) {
    if (key in engine.settings) accepted[key] = engine.settings[key];
  }
  store.save(accepted);
  return engine.snapshot();
});
ipcMain.handle("window:minimize", () => win.minimize());

// ── Deposit (Polymarket Bridge) ─────────────────────────────────────────────
function failOf(err) {
  return { ok: false, reason: String((err && err.message) || err) };
}
ipcMain.handle("deposit:assets", async () => {
  setProxy(store.value.proxyUrl); // the bridge is geoblocked like the CLOB
  try {
    return { ok: true, tokens: await bridge.assets() };
  } catch (err) {
    return failOf(err);
  }
});
ipcMain.handle("deposit:address", async (_e, addressType) => {
  setProxy(store.value.proxyUrl);
  const wallet = store.value.walletAddress || "";
  if (!wallet) return { ok: false, reason: "wallet_missing" };
  try {
    const all = await bridge.addresses(wallet);
    const address = all[addressType];
    if (!address) return { ok: false, reason: "type_unsupported" };
    const qr = await QRCode.toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: "M" });
    return { ok: true, wallet, address, qr };
  } catch (err) {
    return failOf(err);
  }
});
ipcMain.handle("deposit:status", async (_e, address) => {
  setProxy(store.value.proxyUrl);
  try {
    return { ok: true, transactions: await bridge.status(address) };
  } catch (err) {
    return failOf(err);
  }
});
ipcMain.handle("clipboard:write", (_e, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
ipcMain.handle("window:close", () => win.close());
ipcMain.handle("window:maximize", () => {
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
