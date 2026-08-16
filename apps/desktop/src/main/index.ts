import { join, resolve } from "node:path";

import { BrowserWindow, app } from "electron";

import { MeshWorkspace } from "@ai-mesh/workspace";

import { desktopChannels } from "../shared/api.js";
import { registerDesktopIpc } from "./ipc.js";

let workspace: MeshWorkspace | undefined;
let mainWindow: BrowserWindow | undefined;
let unsubscribeWorkspace: (() => void) | undefined;
let unregisterIpc: (() => void) | undefined;

const workspaceRoot = resolve(process.env.MESH_WORKSPACE_ROOT ?? process.cwd());

void app
  .whenReady()
  .then(() => {
    workspace = MeshWorkspace.open({ root: workspaceRoot });
    unregisterIpc = registerDesktopIpc(workspace);
    unsubscribeWorkspace = workspace.subscribe((snapshot) => {
      mainWindow?.webContents.send(desktopChannels.snapshotUpdated, snapshot);
    });
    mainWindow = createWindow();
  })
  .catch((error: unknown) => {
    console.error("Could not start Mesh:", error);
    app.exit(1);
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (workspace === undefined) {
    return;
  }
  event.preventDefault();
  const closing = workspace;
  workspace = undefined;
  unsubscribeWorkspace?.();
  unsubscribeWorkspace = undefined;
  unregisterIpc?.();
  unregisterIpc = undefined;
  void closing
    .close()
    .catch((error: unknown) => console.error("Could not close Mesh cleanly:", error))
    .finally(() => app.exit(0));
});

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: "Mesh",
    backgroundColor: "#f7f7f5",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload-bundle/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(join(import.meta.dirname, "../../renderer/index.html"));
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  return window;
}
