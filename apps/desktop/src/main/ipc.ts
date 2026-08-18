import { dialog, ipcMain } from "electron";

import { desktopChannels, type DesktopApi } from "../shared/api.js";
import type { DesktopWorkspaceHost } from "./workspace-host.js";

const requestChannels = Object.freeze([
  desktopChannels.snapshot,
  desktopChannels.workspaceCatalog,
  desktopChannels.chooseWorkspaceDirectory,
  desktopChannels.openWorkspace,
  desktopChannels.createSession,
  desktopChannels.selectSession,
  desktopChannels.renameSession,
  desktopChannels.archiveSession,
  desktopChannels.renameWorkspace,
  desktopChannels.removeWorkspace,
  desktopChannels.configPreview,
  desktopChannels.saveConfig,
  desktopChannels.reloadConfig,
  desktopChannels.postMessage,
  desktopChannels.createTask,
  desktopChannels.claimTask,
  desktopChannels.updateTask,
  desktopChannels.agentAction,
  desktopChannels.probeAgents,
  desktopChannels.startAvailableAgents,
]);

export interface DesktopIpcOptions {
  readonly chooseWorkspaceDirectory?: () => Promise<string | undefined>;
}

/** Register the Electron transport for the browser-safe application contract. */
export function registerDesktopIpc(
  host: DesktopWorkspaceHost,
  options: DesktopIpcOptions = {},
): () => void {
  ipcMain.handle(desktopChannels.snapshot, () => host.run((workspace) => workspace.snapshot()));
  ipcMain.handle(desktopChannels.workspaceCatalog, () => host.catalog());
  ipcMain.handle(desktopChannels.chooseWorkspaceDirectory, async () => {
    const root = options.chooseWorkspaceDirectory === undefined
      ? await chooseNativeWorkspaceDirectory()
      : await options.chooseWorkspaceDirectory();
    return root === undefined ? null : { root };
  });
  ipcMain.handle(
    desktopChannels.openWorkspace,
    (_event, input: Parameters<DesktopApi["openWorkspace"]>[0]) => host.openWorkspace(input),
  );
  ipcMain.handle(
    desktopChannels.createSession,
    (_event, input: Parameters<DesktopApi["createSession"]>[0]) => host.createSession(input),
  );
  ipcMain.handle(
    desktopChannels.selectSession,
    (_event, input: Parameters<DesktopApi["selectSession"]>[0]) => host.selectSession(input),
  );
  ipcMain.handle(
    desktopChannels.renameSession,
    (_event, input: Parameters<DesktopApi["renameSession"]>[0]) => host.renameSession(input),
  );
  ipcMain.handle(
    desktopChannels.archiveSession,
    (_event, input: Parameters<DesktopApi["archiveSession"]>[0]) => host.archiveSession(input),
  );
  ipcMain.handle(
    desktopChannels.renameWorkspace,
    (_event, input: Parameters<DesktopApi["renameWorkspace"]>[0]) => host.renameWorkspace(input),
  );
  ipcMain.handle(
    desktopChannels.removeWorkspace,
    (_event, input: Parameters<DesktopApi["removeWorkspace"]>[0]) => host.removeWorkspace(input),
  );
  ipcMain.handle(desktopChannels.configPreview, () =>
    host.run((workspace) => workspace.configPreview()),
  );
  ipcMain.handle(
    desktopChannels.saveConfig,
    (_event, input: Parameters<DesktopApi["saveConfig"]>[0]) => host.saveConfig(input),
  );
  ipcMain.handle(desktopChannels.reloadConfig, () => host.reloadConfig());
  ipcMain.handle(
    desktopChannels.postMessage,
    (_event, input: Parameters<DesktopApi["postMessage"]>[0]) => host.postMessage(input),
  );
  ipcMain.handle(
    desktopChannels.createTask,
    (_event, input: Parameters<DesktopApi["createTask"]>[0]) => host.run((activeWorkspace) => {
      activeWorkspace.createTask(input);
      return activeWorkspace.snapshot();
    }),
  );
  ipcMain.handle(
    desktopChannels.claimTask,
    (_event, input: Parameters<DesktopApi["claimTask"]>[0]) => host.run((activeWorkspace) => {
      const result = activeWorkspace.claimTask(
        input.taskId,
        activeWorkspace.resolveParticipant(input.ownerId),
      );
      assertCommitted(result, "claim task");
      return activeWorkspace.snapshot();
    }),
  );
  ipcMain.handle(
    desktopChannels.updateTask,
    (_event, input: Parameters<DesktopApi["updateTask"]>[0]) => host.run((activeWorkspace) => {
      const result = activeWorkspace.updateTask(input);
      assertCommitted(result, "update task");
      return activeWorkspace.snapshot();
    }),
  );
  ipcMain.handle(
    desktopChannels.agentAction,
    (_event, input: Parameters<DesktopApi["agentAction"]>[0]) => host.run(async (activeWorkspace) => {
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
    }),
  );
  ipcMain.handle(desktopChannels.probeAgents, () => host.probeAgents());
  ipcMain.handle(desktopChannels.startAvailableAgents, () =>
    host.run(async (activeWorkspace) => {
      await activeWorkspace.startAvailableAgents();
      return activeWorkspace.snapshot();
    }),
  );

  let registered = true;
  return () => {
    if (!registered) {
      return;
    }
    registered = false;
    for (const channel of requestChannels) {
      ipcMain.removeHandler(channel);
    }
  };
}

async function chooseNativeWorkspaceDirectory(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: "选择 Mesh 项目目录",
    buttonLabel: "打开项目",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
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
