"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vespera", {
  listSetups: () => ipcRenderer.invoke("setups:list"),
  saveSetup: (input) => ipcRenderer.invoke("setups:save", input),
  applySetup: (input) => ipcRenderer.invoke("setups:apply", input),
  copySetup: (input) => ipcRenderer.invoke("setups:copy", input),
  importSetup: () => ipcRenderer.invoke("setups:import"),
  exportSetup: (input) => ipcRenderer.invoke("setups:export", input),
  inspectPendingOrder: () => ipcRenderer.invoke("risk:inspectOrder"),
  resolvePendingOrder: (input) => ipcRenderer.invoke("risk:resolveOrder", input),
  reconcileFinalSettlement: () => ipcRenderer.invoke("risk:finalSettlement"),
  snapshot: () => ipcRenderer.invoke("engine:snapshot"),
  warmChart: () => ipcRenderer.invoke("engine:warmChart"),
  start: (opts) => ipcRenderer.invoke("engine:start", opts),
  stop: () => ipcRenderer.invoke("engine:stop"),
  setMode: (mode) => ipcRenderer.invoke("engine:setMode", mode),
  confirmLot: (baseUsd, opts) => ipcRenderer.invoke("engine:confirmLot", baseUsd, opts),
  ping: (creds) => ipcRenderer.invoke("engine:ping", creds),
  deriveKeys: (patch) => ipcRenderer.invoke("engine:deriveKeys", patch),
  connect: (patch) => ipcRenderer.invoke("engine:connect", patch),
  testOrder: (opts) => ipcRenderer.invoke("engine:testOrder", opts),
  exportCsv: () => ipcRenderer.invoke("journal:exportCsv"),
  depositAssets: () => ipcRenderer.invoke("deposit:assets"),
  depositAddress: (addressType) => ipcRenderer.invoke("deposit:address", addressType),
  depositStatus: (address) => ipcRenderer.invoke("deposit:status", address),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  resetPaper: (startingBalance) => ipcRenderer.invoke("engine:resetPaper", startingBalance),
  setStrategy: (id) => ipcRenderer.invoke("engine:setStrategy", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  telegramStatus: () => ipcRenderer.invoke("telegram:status"),
  telegramConfigure: (patch) => ipcRenderer.invoke("telegram:configure", patch),
  telegramPair: () => ipcRenderer.invoke("telegram:pair"),
  telegramTest: () => ipcRenderer.invoke("telegram:test"),
  telegramDisconnect: () => ipcRenderer.invoke("telegram:disconnect"),
  getExecution: () => ipcRenderer.invoke("execution:get"),
  configureExecution: (patch) => ipcRenderer.invoke("execution:configure", patch),
  setExecutionMode: (mode) => ipcRenderer.invoke("execution:setMode", mode),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  onEvent: (fn) => {
    const wrapped = (_e, data) => fn(data);
    ipcRenderer.on("engine:event", wrapped);
    return () => ipcRenderer.removeListener("engine:event", wrapped);
  },
});
