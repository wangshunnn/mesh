export {
  workspaceConfigVersion,
  type AgentView,
  type MessageView,
  type RoomSnapshot,
  type TaskView,
  type WorkspaceAdapterKind,
  type WorkspaceAgentConfig,
  type WorkspaceConfig,
  type WorkspaceConfigPreview,
  type WorkspaceConfigSource,
  type WorkspacePermissionPolicy,
} from "@ai-mesh/application";
export type { TraceRecord } from "@ai-mesh/protocol";

export {
  createBuiltinWorkspaceAdapterRegistry,
  WorkspaceAdapterRegistry,
  type WorkspaceAdapterProvider,
} from "./adapters.js";
export {
  defaultWorkspaceConfig,
  previewWorkspaceConfig,
  resolveWorkspaceRoot,
  validateWorkspaceConfig,
  type WorkspaceConfigInput,
} from "./config.js";
export {
  MeshWorkspace,
  type AgentProbeResult,
  type OpenWorkspaceOptions,
  type StartAvailableAgentsResult,
} from "./workspace.js";
