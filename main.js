"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { loadConfig, publicConfig } = require("./lib/config");
const { createRenderServer } = require("./lib/server");

let mainWindow = null;
let provider = null;
let lastCompletedImage = null;

function sendRenderEvent(eventName, payload) {
  if (eventName === "complete") lastCompletedImage = payload.image;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (eventName === "created") {
    mainWindow.webContents.send("render-event", { type: "begin", status: payload });
  } else if (eventName === "chunk") {
    mainWindow.webContents.send("render-event", {
      type: "chunk",
      offset: payload.offset,
      pixels: payload.pixels,
      progress: payload.progress,
    });
  } else if (eventName === "complete") {
    mainWindow.webContents.send("render-event", {
      type: "complete",
      status: payload.status,
    });
  }
}

async function startProvider() {
  if (provider?.server.listening) {
    return { status: "already-running", config: publicConfig(provider.config) };
  }
  const config = loadConfig(process.env);
  provider = createRenderServer(config, { onEvent: sendRenderEvent });
  provider.config = config;
  const address = await provider.listen();
  return {
    status: "ready",
    address: { host: address.address, port: address.port },
    config: publicConfig(config),
  };
}

function registerIpc() {
  ipcMain.handle("get-platform", () => process.platform);
  ipcMain.handle("start-server", () => startProvider());
  ipcMain.handle("open-help", () => shell.openExternal("https://github.com/waskosky/RoRenderV3#readme"));
  ipcMain.handle("export-image", async () => {
    if (!lastCompletedImage) return { status: "unavailable" };
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "Save rendered map",
      buttonLabel: "Save",
      defaultPath: "map.png",
      filters: [{ name: "PNG image", extensions: ["png"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (selection.canceled || !selection.filePath) return { status: "canceled" };
    await fs.writeFile(selection.filePath, lastCompletedImage, { mode: 0o600 });
    return { status: "saved" };
  });
}

function createWindow() {
  const isWindows = process.platform === "win32";
  mainWindow = new BrowserWindow({
    show: false,
    resizable: true,
    height: isWindows ? 683 : 600,
    width: isWindows ? 1024 : 820,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!provider?.server.listening) return;
  event.preventDefault();
  provider.close().finally(() => {
    provider = null;
    app.quit();
  });
});
