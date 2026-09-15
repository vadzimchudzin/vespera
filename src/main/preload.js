"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vespera", {
  snapshot: () => ipcRenderer.invoke("engine:snapshot"),
  start: () => ipcRenderer.invoke("engine:start"),
  stop: () => ipcRenderer.invoke("engine:stop"),
  setMode: (mode) => ipcRenderer.invoke("engine:setMode", mode),
  confirmLot: (baseUsd) => ipcRenderer.invoke("engine:confirmLot", baseUsd),
  ping: (apiKey) => ipcRenderer.invoke("engine:ping", apiKey),
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
