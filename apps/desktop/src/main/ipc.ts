import { ipcMain } from "electron";

import type { MessageAttention } from "@ai-mesh/protocol";

import { desktopChannels, type DesktopApi } from "../shared/api.js";
import type { DesktopWorkspaceHost } from "./workspace-host.js";

const requestChannels = Object.freeze([
  desktopChannels.snapshot,
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

/** Register the Electron transport for the browser-safe application contract. */
export function registerDesktopIpc(host: DesktopWorkspaceHost): () => void {
  ipcMain.handle(desktopChannels.snapshot, () => host.run((workspace) => workspace.snapshot()));
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
    (_event, input: Parameters<DesktopApi["postMessage"]>[0]) => host.run((activeWorkspace) => {
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
    }),
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
  ipcMain.handle(desktopChannels.probeAgents, () =>
    host.run(async (activeWorkspace) => {
      const probes = await activeWorkspace.probeAgents();
      return probes.map((probe) => ({
        id: probe.id,
        available: probe.availability.available,
        ...(probe.availability.version === undefined ? {} : { version: probe.availability.version }),
        ...(probe.availability.reason === undefined ? {} : { reason: probe.availability.reason }),
      }));
    }),
  );
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
