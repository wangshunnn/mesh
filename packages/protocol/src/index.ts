export type RoomId = string;
export type ParticipantId = string;
export type EventId = string;
export type IntentId = string;
export type IdempotencyKey = string;

export type SubjectKind =
  | "room"
  | "thread"
  | "task"
  | "decision"
  | "artifact"
  | "resource"
  | "participant";

export interface SubjectRef {
  readonly kind: SubjectKind;
  readonly id: string;
}

export interface SubjectVersion {
  readonly subject: SubjectRef;
  readonly version: number;
}

export interface CausalBasis extends SubjectVersion {}

export interface Intent<TPayload = unknown> {
  readonly id: IntentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly roomId: RoomId;
  readonly actorId: ParticipantId;
  readonly subject: SubjectRef;
  readonly action: string;
  readonly payload: TPayload;
  readonly basedOn?: readonly CausalBasis[];
}

export interface RoomEvent<TPayload = unknown> {
  readonly id: EventId;
  readonly sequence: number;
  readonly roomId: RoomId;
  readonly actorId: ParticipantId;
  readonly subject: SubjectRef;
  readonly subjectVersion: number;
  readonly action: string;
  readonly payload: TPayload;
  readonly intentId: IntentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly causedBy: readonly CausalBasis[];
  readonly committedAt: number;
}

export interface Committed<TPayload = unknown> {
  readonly status: "committed";
  readonly event: RoomEvent<TPayload>;
  readonly replayed: boolean;
}

export interface NeedsRebase {
  readonly status: "needs_rebase";
  readonly conflicts: readonly SubjectConflict[];
}

export interface SubjectConflict {
  readonly subject: SubjectRef;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly changesSinceBasis: readonly RoomEvent[];
}

export interface Rejected {
  readonly status: "rejected";
  readonly code:
    | "unknown_action"
    | "missing_basis"
    | "invalid_basis"
    | "not_found"
    | "already_claimed"
    | "idempotency_conflict";
  readonly message: string;
  readonly currentVersion?: number;
  readonly conflictingEvent?: RoomEvent;
}

export type CommitResult<TPayload = unknown> = Committed<TPayload> | NeedsRebase | Rejected;

export const CoreAction = {
  threadMessageAppend: "thread.message.append",
  threadReplyCommit: "thread.reply.commit",
  participantPresenceSet: "participant.presence.set",
  agentTurnComplete: "agent.turn.complete",
  taskCreate: "task.create",
  taskClaim: "task.claim",
  taskUpdate: "task.update",
  decisionPropose: "decision.propose",
  artifactPublish: "artifact.publish",
} as const;

export type CoreActionName = (typeof CoreAction)[keyof typeof CoreAction];

/**
 * Attention is routing metadata, not an access-control boundary. Every message
 * remains part of the shared room log and is visible to every participant.
 */
export type MessageAttention = "team" | readonly ParticipantId[];

export interface RoomMessagePayload {
  readonly kind: "message";
  readonly text: string;
  readonly attention: MessageAttention;
  readonly respondingTo: readonly EventId[];
}

export type ParticipantPresence =
  | "starting"
  | "idle"
  | "working"
  | "waiting"
  | "error"
  | "offline";

export interface PresencePayload {
  readonly kind: "presence";
  readonly state: ParticipantPresence;
  readonly adapterKind?: string;
  readonly sessionId?: string;
  readonly detail?: string;
}

export interface AgentTurnCompletedPayload {
  readonly kind: "agent-turn-completed";
  readonly respondingTo: readonly EventId[];
  readonly outcome: "replied" | "empty" | "cancelled" | "refused" | "error";
  readonly replyEventId?: EventId;
}

/**
 * Developer-facing runtime diagnostics live outside the canonical room ledger.
 * They may contain candidate output that was never committed as a shared fact.
 */
export type TraceStatus =
  | "info"
  | "running"
  | "dirty"
  | "pending"
  | "committed"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";

export interface TraceRecordInput {
  readonly id: string;
  readonly roomId: RoomId;
  readonly actorId: ParticipantId;
  readonly kind: string;
  readonly status: TraceStatus;
  readonly occurredAt: number;
  /** Stable across participants and retries caused by the same room trigger set. */
  readonly correlationId?: string;
  readonly turnId?: string;
  readonly attempt?: number;
  readonly content?: string;
  readonly detail?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface TraceRecord extends TraceRecordInput {
  /** Monotonic sequence in the diagnostic journal, independent of RoomEvent.sequence. */
  readonly sequence: number;
}

export interface TraceJournal {
  append(input: TraceRecordInput): TraceRecord;
  read(): readonly TraceRecord[];
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "review" | "done";

export interface TaskCreatedPayload {
  readonly kind: "task-created";
  readonly title: string;
  readonly description?: string;
  readonly status: "todo";
}

export interface TaskClaimedPayload {
  readonly kind: "task-claimed";
  readonly ownerId: ParticipantId;
}

export interface TaskUpdatedPayload {
  readonly kind: "task-updated";
  readonly status: TaskStatus;
  readonly note?: string;
}

export function subjectKey(subject: SubjectRef): string {
  return `${subject.kind}:${subject.id}`;
}

export function sameSubject(left: SubjectRef, right: SubjectRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
