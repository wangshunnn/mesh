import { join, resolve } from "node:path";

import { BrowserWindow, app, ipcMain } from "electron";

import type { MessageAttention, TaskStatus } from "@ai-mesh/protocol";
import { MeshWorkspace } from "@ai-mesh/workspace";

import { desktopChannels, type AgentAction } from "../shared/api.js";

let workspace: MeshWorkspace | undefined;
let mainWindow: BrowserWindow | undefined;
let unsubscribeWorkspace: (() => void) | undefined;

const workspaceRoot = resolve(process.env.MESH_WORKSPACE_ROOT ?? process.cwd());

void app
  .whenReady()
  .then(() => {
    workspace = MeshWorkspace.open({ root: workspaceRoot });
    registerIpc(workspace);
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

function registerIpc(activeWorkspace: MeshWorkspace): void {
  ipcMain.handle(desktopChannels.snapshot, () => activeWorkspace.snapshot());
  ipcMain.handle(
    desktopChannels.postMessage,
    async (_event, input: { readonly text: string; readonly to?: string }) => {
      const attention: MessageAttention | undefined =
        input.to === undefined
          ? undefined
          : input.to === "team"
            ? "team"
            : [activeWorkspace.resolveParticipant(input.to)];
      activeWorkspace.postText(input.text, {
        ...(attention === undefined ? {} : { attention }),
      });
      return activeWorkspace.snapshot();
    },
  );
  ipcMain.handle(
    desktopChannels.createTask,
    (_event, input: { readonly title: string; readonly description?: string }) => {
      activeWorkspace.createTask(input);
      return activeWorkspace.snapshot();
    },
  );
  ipcMain.handle(
    desktopChannels.claimTask,
    (_event, input: { readonly taskId: string; readonly ownerId: string }) => {
      const result = activeWorkspace.claimTask(
        input.taskId,
        activeWorkspace.resolveParticipant(input.ownerId),
      );
      assertCommitted(result, "claim task");
      return activeWorkspace.snapshot();
    },
  );
  ipcMain.handle(
    desktopChannels.updateTask,
    (_event, input: { readonly taskId: string; readonly status: TaskStatus }) => {
      const result = activeWorkspace.updateTask(input);
      assertCommitted(result, "update task");
      return activeWorkspace.snapshot();
    },
  );
  ipcMain.handle(
    desktopChannels.agentAction,
    async (_event, input: { readonly agentId: string; readonly action: AgentAction }) => {
      switch (input.action) {
        case "start":
          await activeWorkspace.startAgent(input.agentId);
          break;
        case "stop":
          await activeWorkspace.stopAgent(input.agentId);
          break;
        case "restart":
          await activeWorkspace.restartAgent(input.agentId);
          break;
        case "wake":
          activeWorkspace.wakeAgent(input.agentId);
          break;
      }
      return activeWorkspace.snapshot();
    },
  );
  ipcMain.handle(desktopChannels.probeAgents, async () => {
    const probes = await activeWorkspace.probeAgents();
    return probes.map((probe) => ({
      id: probe.id,
      available: probe.availability.available,
      ...(probe.availability.version === undefined ? {} : { version: probe.availability.version }),
      ...(probe.availability.reason === undefined ? {} : { reason: probe.availability.reason }),
    }));
  });
  ipcMain.handle(desktopChannels.startAvailableAgents, async () => {
    await activeWorkspace.startAvailableAgents();
    return activeWorkspace.snapshot();
  });
}

function assertCommitted(
  result: { readonly status: string; readonly code?: string; readonly message?: string },
  action: string,
): void {
  if (result.status !== "committed") {
    throw new Error(
      `Could not ${action}: ${result.code ?? result.status}${result.message === undefined ? "" : ` — ${result.message}`}`,
    );
  }
}
