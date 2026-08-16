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
  type WorkspaceConfigWriteResult,
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
  parseWorkspaceConfig,
  previewWorkspaceConfig,
  saveWorkspaceConfig,
  serializeWorkspaceConfig,
  validateWorkspaceConfig,
  WorkspaceConfigConflictError,
  WorkspaceConfigLockedError,
  type SaveWorkspaceConfigInput,
  type WorkspaceConfigInput,
} from "./config.js";
export {
  inspectWorkspaceStorage,
  listWorkspaceRegistrations,
  prepareWorkspaceStorage,
  registerWorkspace,
  resolveMeshHome,
  resolveWorkspaceRoot,
  workspaceRegistryVersion,
  WorkspaceMigrationConflictError,
  WorkspaceMigrationLockedError,
  WorkspaceRegistrationConflictError,
  WorkspaceRegistryLockedError,
  WorkspaceStorageOverlapError,
  type WorkspaceRegistration,
  type WorkspaceStorageInput,
  type WorkspaceStorageLocation,
} from "./storage.js";
export {
  MeshWorkspace,
  type AgentProbeResult,
  type OpenWorkspaceOptions,
  type StartAvailableAgentsResult,
} from "./workspace.js";
