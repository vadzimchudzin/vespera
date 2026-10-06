"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vespera", {
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
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  onEvent: (fn) => {
    const wrapped = (_e, data) => fn(data);
    ipcRenderer.on("engine:event", wrapped);
    return () => ipcRenderer.removeListener("engine:event", wrapped);
  },
});
