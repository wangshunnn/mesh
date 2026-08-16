import type { RoomSnapshot } from "@ai-mesh/application";
import type { AgentAdapter, AgentPermissionPolicy } from "@ai-mesh/agent";
import type {
  EventId,
  MessageAttention,
  ParticipantId,
  RoomEvent,
  SubjectRef,
  TaskStatus,
  TraceJournal,
} from "@ai-mesh/protocol";
import type { CommitNotification, RoomLedger } from "@ai-mesh/room";
import type { CursorStore } from "@ai-mesh/runtime";

export interface AgentDefinition {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapter: AgentAdapter;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly systemPrompt?: string;
  readonly permissionPolicy?: AgentPermissionPolicy;
  readonly respondToTeam?: boolean;
}

export type TurnChangeImpact = "irrelevant" | "soft" | "hard";

export interface TurnChangeContext {
  readonly agentId: ParticipantId;
  readonly subject: SubjectRef;
  readonly basedOnVersion: number;
  readonly triggerIds: readonly EventId[];
}

export type TurnChangeClassifier = (
  event: RoomEvent,
  context: TurnChangeContext,
) => TurnChangeImpact;

export interface CollaborationRuntimeOptions {
  readonly room: RoomLedger;
  readonly cursors: CursorStore;
  readonly cwd: string;
  readonly humanId?: ParticipantId;
  readonly humanHandle?: string;
  readonly defaultThreadId?: string;
  readonly maxRebaseAttempts?: number;
  readonly maxReconciliationPasses?: number;
  readonly maxReconciliationDeltaEvents?: number;
  readonly reconciliationQuietWindowMs?: number;
  readonly classifyTurnChange?: TurnChangeClassifier;
  readonly traces?: TraceJournal;
}

export interface PostMessageInput {
  readonly text: string;
  readonly attention?: MessageAttention;
  readonly actorId?: ParticipantId;
  readonly threadId?: string;
  readonly respondingTo?: readonly EventId[];
  readonly idempotencyKey?: string;
}

export interface CreateTaskInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly actorId?: ParticipantId;
  readonly idempotencyKey?: string;
}

export interface UpdateTaskInput {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly note?: string;
  readonly actorId?: ParticipantId;
  readonly idempotencyKey?: string;
}

export type SnapshotListener = (
  snapshot: RoomSnapshot,
  notification: CommitNotification | undefined,
) => void;
