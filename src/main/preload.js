"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vespera", {
  snapshot: () => ipcRenderer.invoke("engine:snapshot"),
  warmChart: () => ipcRenderer.invoke("engine:warmChart"),
  start: () => ipcRenderer.invoke("engine:start"),
  stop: () => ipcRenderer.invoke("engine:stop"),
  setMode: (mode) => ipcRenderer.invoke("engine:setMode", mode),
  confirmLot: (baseUsd) => ipcRenderer.invoke("engine:confirmLot", baseUsd),
  ping: (creds) => ipcRenderer.invoke("engine:ping", creds),
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
