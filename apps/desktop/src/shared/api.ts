import type { AgentProbeView, MeshClient } from "@ai-mesh/application";

/** Electron transport implementation of the browser-safe application contract. */
export type DesktopApi = MeshClient;
export type DesktopAgentProbe = AgentProbeView;
export type { AgentAction } from "@ai-mesh/application";

export const desktopChannels = Object.freeze({
  snapshot: "mesh:snapshot",
  configPreview: "mesh:config-preview",
  saveConfig: "mesh:save-config",
  reloadConfig: "mesh:reload-config",
  snapshotUpdated: "mesh:snapshot-updated",
  postMessage: "mesh:post-message",
  createTask: "mesh:create-task",
  claimTask: "mesh:claim-task",
  updateTask: "mesh:update-task",
  agentAction: "mesh:agent-action",
  probeAgents: "mesh:probe-agents",
  startAvailableAgents: "mesh:start-available-agents",
});
