import type {
  EventId,
  MessageAttention,
  ParticipantId,
  ParticipantPresence,
  RoomEvent,
  TaskStatus,
  TraceRecord,
} from "@ai-mesh/protocol";

/** Browser-safe projection of one configured Agent. */
export interface AgentView {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapterKind: string;
  readonly state: ParticipantPresence;
  readonly sessionId?: string;
  readonly detail?: string;
  readonly updatedAt?: number;
}

/** Browser-safe projection of one canonical Room message. */
export interface MessageView {
  readonly eventId: EventId;
  readonly sequence: number;
  readonly threadId: string;
  readonly from: ParticipantId;
  readonly text: string;
  readonly attention: MessageAttention;
  readonly respondingTo: readonly EventId[];
  readonly createdAt: number;
}

/** Browser-safe projection of one Room task. */
export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly ownerId?: ParticipantId;
  readonly version: number;
  readonly updatedAt: number;
}

/** Complete local Room projection used by product clients at the current MVP scale. */
export interface RoomSnapshot {
  readonly roomId: string;
  readonly headSequence: number;
  readonly agents: readonly AgentView[];
  readonly messages: readonly MessageView[];
  readonly tasks: readonly TaskView[];
  readonly timeline: readonly RoomEvent[];
  readonly trace: readonly TraceRecord[];
}

export const workspaceConfigVersion = 1;

/** Configuration version 1 intentionally remains closed to the two verified providers. */
export type WorkspaceAdapterKind = "opencode-acp" | "codex-native";

export type WorkspacePermissionPolicy = "deny" | "allow-once" | "allow-always";

export interface WorkspaceAgentConfig {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapter: WorkspaceAdapterKind;
  readonly command?: string;
  readonly permissionPolicy?: WorkspacePermissionPolicy;
  readonly respondToTeam?: boolean;
  readonly systemPrompt?: string;
}

export interface WorkspaceConfig {
  readonly version: typeof workspaceConfigVersion;
  readonly roomId: string;
  readonly agents: readonly WorkspaceAgentConfig[];
}

export type WorkspaceConfigSource = "provided" | "file" | "default";

/** Effective, read-only local configuration projection; it carries no write policy. */
export interface WorkspaceConfigPreview {
  readonly root: string;
  readonly dataDirectory: string;
  readonly configPath: string;
  readonly databasePath: string;
  /** Opaque revision of the persisted config file, or null when no file backs the preview. */
  readonly revision: string | null;
  readonly source: WorkspaceConfigSource;
  readonly config: WorkspaceConfig;
}

/** Result of one revision-checked, atomic local configuration save. */
export interface WorkspaceConfigWriteResult extends WorkspaceConfigPreview {
  readonly changed: boolean;
}

export interface WorkspaceConfigSaveInput {
  readonly expectedRevision: string | null;
  readonly config: WorkspaceConfig;
}

export type AgentAction = "start" | "stop" | "restart" | "wake";

export interface AgentProbeView {
  readonly id: string;
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

/**
 * Transport-neutral contract presented to a local product client.
 *
 * Electron IPC is the only implementation today. A future HTTP transport must
 * preserve this application boundary rather than expose workspace internals.
 */
export interface MeshClient {
  snapshot(): Promise<RoomSnapshot>;
  configPreview(): Promise<WorkspaceConfigPreview>;
  saveConfig(input: WorkspaceConfigSaveInput): Promise<WorkspaceConfigWriteResult>;
  reloadConfig(): Promise<WorkspaceConfigPreview>;
  postMessage(input: { readonly text: string; readonly to?: string }): Promise<RoomSnapshot>;
  createTask(input: {
    readonly title: string;
    readonly description?: string;
  }): Promise<RoomSnapshot>;
  claimTask(input: { readonly taskId: string; readonly ownerId: string }): Promise<RoomSnapshot>;
  updateTask(input: { readonly taskId: string; readonly status: TaskStatus }): Promise<RoomSnapshot>;
  agentAction(input: { readonly agentId: string; readonly action: AgentAction }): Promise<RoomSnapshot>;
  probeAgents(): Promise<readonly AgentProbeView[]>;
  startAvailableAgents(): Promise<RoomSnapshot>;
  onSnapshot(listener: (snapshot: RoomSnapshot) => void): () => void;
}
