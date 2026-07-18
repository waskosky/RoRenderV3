"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roRender", {
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  startServer: () => ipcRenderer.invoke("start-server"),
  openHelp: () => ipcRenderer.invoke("open-help"),
  exportImage: () => ipcRenderer.invoke("export-image"),
  onRenderEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("render-event", wrapped);
    return () => ipcRenderer.removeListener("render-event", wrapped);
  },
});
