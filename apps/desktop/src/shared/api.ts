import type { RoomSnapshot, WorkspaceConfigPreview } from "@ai-mesh/workspace";
import type { TaskStatus } from "@ai-mesh/protocol";

export type AgentAction = "start" | "stop" | "restart" | "wake";

export interface DesktopAgentProbe {
  readonly id: string;
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface DesktopApi {
  snapshot(): Promise<RoomSnapshot>;
  configPreview(): Promise<WorkspaceConfigPreview>;
  postMessage(input: { readonly text: string; readonly to?: string }): Promise<RoomSnapshot>;
  createTask(input: { readonly title: string; readonly description?: string }): Promise<RoomSnapshot>;
  claimTask(input: { readonly taskId: string; readonly ownerId: string }): Promise<RoomSnapshot>;
  updateTask(input: { readonly taskId: string; readonly status: TaskStatus }): Promise<RoomSnapshot>;
  agentAction(input: { readonly agentId: string; readonly action: AgentAction }): Promise<RoomSnapshot>;
  probeAgents(): Promise<readonly DesktopAgentProbe[]>;
  startAvailableAgents(): Promise<RoomSnapshot>;
  onSnapshot(listener: (snapshot: RoomSnapshot) => void): () => void;
}

export const desktopChannels = Object.freeze({
  snapshot: "mesh:snapshot",
  configPreview: "mesh:config-preview",
  snapshotUpdated: "mesh:snapshot-updated",
  postMessage: "mesh:post-message",
  createTask: "mesh:create-task",
  claimTask: "mesh:claim-task",
  updateTask: "mesh:update-task",
  agentAction: "mesh:agent-action",
  probeAgents: "mesh:probe-agents",
  startAvailableAgents: "mesh:start-available-agents",
});
