"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The ring window gets one read-only feed: the agents' paper positions grouped by event, every few seconds.
contextBridge.exposeInMainWorld("vesperaRing", {
  onAgents: (fn) => {
    if (typeof fn !== "function") return () => {};
    const wrapped = (_e, data) => { try { fn(data); } catch { /* a drawing error never breaks the feed */ } };
    ipcRenderer.on("ring:agents", wrapped);
    return () => ipcRenderer.removeListener("ring:agents", wrapped);
  },
});
