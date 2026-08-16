import { contextBridge, ipcRenderer } from "electron";

import {
  desktopChannels,
  type DesktopApi,
  type DesktopAgentProbe,
} from "../shared/api.js";

const api: DesktopApi = Object.freeze({
  snapshot: () => ipcRenderer.invoke(desktopChannels.snapshot) as Promise<Awaited<ReturnType<DesktopApi["snapshot"]>>>,
  configPreview: () =>
    ipcRenderer.invoke(desktopChannels.configPreview) as Promise<Awaited<ReturnType<DesktopApi["configPreview"]>>>,
  saveConfig: (input: Parameters<DesktopApi["saveConfig"]>[0]) =>
    ipcRenderer.invoke(desktopChannels.saveConfig, input) as Promise<Awaited<ReturnType<DesktopApi["saveConfig"]>>>,
  reloadConfig: () =>
    ipcRenderer.invoke(desktopChannels.reloadConfig) as Promise<Awaited<ReturnType<DesktopApi["reloadConfig"]>>>,
  postMessage: (input: Parameters<DesktopApi["postMessage"]>[0]) =>
    ipcRenderer.invoke(desktopChannels.postMessage, input) as Promise<Awaited<ReturnType<DesktopApi["postMessage"]>>>,
  createTask: (input: Parameters<DesktopApi["createTask"]>[0]) =>
    ipcRenderer.invoke(desktopChannels.createTask, input) as Promise<Awaited<ReturnType<DesktopApi["createTask"]>>>,
  claimTask: (input: Parameters<DesktopApi["claimTask"]>[0]) =>
    ipcRenderer.invoke(desktopChannels.claimTask, input) as Promise<Awaited<ReturnType<DesktopApi["claimTask"]>>>,
  updateTask: (input: Parameters<DesktopApi["updateTask"]>[0]) =>
    ipcRenderer.invoke(desktopChannels.updateTask, input) as Promise<Awaited<ReturnType<DesktopApi["updateTask"]>>>,
  agentAction: (input: Parameters<DesktopApi["agentAction"]>[0]) =>
    ipcRenderer.invoke(desktopChannels.agentAction, input) as Promise<Awaited<ReturnType<DesktopApi["agentAction"]>>>,
  probeAgents: () =>
    ipcRenderer.invoke(desktopChannels.probeAgents) as Promise<readonly DesktopAgentProbe[]>,
  startAvailableAgents: () =>
    ipcRenderer.invoke(desktopChannels.startAvailableAgents) as Promise<Awaited<ReturnType<DesktopApi["startAvailableAgents"]>>>,
  onSnapshot: (listener: Parameters<DesktopApi["onSnapshot"]>[0]) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => {
      listener(snapshot);
    };
    ipcRenderer.on(desktopChannels.snapshotUpdated, handler);
    return () => ipcRenderer.removeListener(desktopChannels.snapshotUpdated, handler);
  },
});

contextBridge.exposeInMainWorld("mesh", api);
