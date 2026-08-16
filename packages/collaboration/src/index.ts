import { randomUUID } from "node:crypto";

import type { RoomSnapshot } from "@ai-mesh/application";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionStatus,
} from "@ai-mesh/agent";
import {
  CoreAction,
  sameSubject,
  type AgentTurnCompletedPayload,
  type CommitResult,
  type Committed,
  type EventId,
  type MessageAttention,
  type ParticipantId,
  type ParticipantPresence,
  type PresencePayload,
  type RoomEvent,
  type RoomMessagePayload,
  type SubjectRef,
  type TaskClaimedPayload,
  type TaskCreatedPayload,
  type TaskUpdatedPayload,
  type TraceJournal,
  type TraceRecord,
  type TraceRecordInput,
} from "@ai-mesh/protocol";
import type { RoomLedger, Unsubscribe } from "@ai-mesh/room";
import { ParticipantInbox, type CursorStore, type InboxBatch } from "@ai-mesh/runtime";

import { freezeAttention, isMessageEvent, isRecord } from "./event-utils.js";
import { collaborationKey, stableId } from "./ids.js";
import {
  buildReconciliationPrompt,
  parseReconciliation,
  type CandidateState,
  type ParsedReconciliation,
} from "./reconciliation.js";
import { projectRoom } from "./room-projection.js";
import { InMemoryTraceJournal, roomEventTrace } from "./trace-journal.js";
import type {
  AgentDefinition,
  CollaborationRuntimeOptions,
  CreateTaskInput,
  PostMessageInput,
  SnapshotListener,
  TurnChangeClassifier,
  TurnChangeContext,
  TurnChangeImpact,
  UpdateTaskInput,
} from "./types.js";

export type { AgentView, MessageView, RoomSnapshot, TaskView } from "@ai-mesh/application";
export type {
  AgentDefinition,
  CollaborationRuntimeOptions,
  CreateTaskInput,
  PostMessageInput,
  SnapshotListener,
  TurnChangeClassifier,
  TurnChangeContext,
  TurnChangeImpact,
  UpdateTaskInput,
} from "./types.js";

/**
 * Product runtime for one shared room.
 *
 * Every participant consumes the canonical room log. Attention determines who
 * should wake and reason; it never hides a message from other participants.
 */
export class CollaborationRuntime {
  readonly room: RoomLedger;
  readonly humanId: ParticipantId;
  readonly defaultThread: SubjectRef;

  readonly #cursors: CursorStore;
  readonly #cwd: string;
  readonly #humanHandle: string;
  readonly #maxRebaseAttempts: number;
  readonly #maxReconciliationPasses: number;
  readonly #maxReconciliationDeltaEvents: number;
  readonly #reconciliationQuietWindowMs: number;
  readonly #classifyTurnChange: TurnChangeClassifier;
  readonly #traces: TraceJournal;
  readonly #definitions = new Map<ParticipantId, AgentDefinition>();
  readonly #handles = new Map<string, ParticipantId>();
  readonly #workers = new Map<ParticipantId, AgentWorker>();
  readonly #sessionIds = new Map<ParticipantId, string>();
  readonly #listeners = new Set<SnapshotListener>();
  readonly #unsubscribeRoom: Unsubscribe;
  #closed = false;

  constructor(options: CollaborationRuntimeOptions) {
    this.room = options.room;
    this.#cursors = options.cursors;
    this.#cwd = options.cwd;
    this.humanId = options.humanId ?? "human";
    this.#humanHandle = normalizeHandle(options.humanHandle ?? "human");
    this.#traces = options.traces ?? new InMemoryTraceJournal();
    this.defaultThread = Object.freeze({
      kind: "thread",
      id: options.defaultThreadId ?? "general",
    });
    this.#maxRebaseAttempts = options.maxRebaseAttempts ?? 3;
    if (!Number.isInteger(this.#maxRebaseAttempts) || this.#maxRebaseAttempts < 1) {
      throw new RangeError("maxRebaseAttempts must be a positive integer.");
    }
    this.#maxReconciliationPasses = options.maxReconciliationPasses ?? 2;
    if (!Number.isInteger(this.#maxReconciliationPasses) || this.#maxReconciliationPasses < 1) {
      throw new RangeError("maxReconciliationPasses must be a positive integer.");
    }
    this.#maxReconciliationDeltaEvents = options.maxReconciliationDeltaEvents ?? 32;
    if (
      !Number.isInteger(this.#maxReconciliationDeltaEvents) ||
      this.#maxReconciliationDeltaEvents < 1
    ) {
      throw new RangeError("maxReconciliationDeltaEvents must be a positive integer.");
    }
    this.#reconciliationQuietWindowMs = options.reconciliationQuietWindowMs ?? 80;
    if (
      !Number.isInteger(this.#reconciliationQuietWindowMs) ||
      this.#reconciliationQuietWindowMs < 0
    ) {
      throw new RangeError("reconciliationQuietWindowMs must be a non-negative integer.");
    }
    this.#classifyTurnChange = options.classifyTurnChange ?? defaultTurnChangeClassifier;
    this.#handles.set(this.#humanHandle, this.humanId);
    for (const event of this.room.readEvents()) {
      this.#traces.append(roomEventTrace(event));
    }
    this.#unsubscribeRoom = this.room.subscribe((notification) => {
      this.#traces.append(roomEventTrace(notification.event));
      const snapshot = this.snapshot();
      for (const listener of this.#listeners) {
        listener(snapshot, notification);
      }
    });
  }

  registerAgent(definition: AgentDefinition): void {
    this.#assertOpen();
    if (this.#definitions.has(definition.id) || definition.id === this.humanId) {
      throw new Error(`Participant ${definition.id} is already registered.`);
    }
    const handle = normalizeHandle(definition.handle);
    const idHandle = normalizeHandle(definition.id);
    if (this.#handles.has(handle) || this.#handles.has(idHandle)) {
      throw new Error(`Handle @${handle} or participant id ${definition.id} is already registered.`);
    }
    const stored = Object.freeze({ ...definition, handle });
    this.#definitions.set(stored.id, stored);
    this.#handles.set(handle, stored.id);
    this.#handles.set(idHandle, stored.id);
    const recoveredSessionId = latestSessionId(this.room, stored.id);
    if (recoveredSessionId !== undefined) {
      this.#sessionIds.set(stored.id, recoveredSessionId);
    }
  }

  async startAgent(agentId: ParticipantId): Promise<void> {
    this.#assertOpen();
    if (this.#workers.has(agentId)) {
      return;
    }
    const definition = this.#requireDefinition(agentId);
    const sessionId = this.#sessionIds.get(agentId) ?? definition.sessionId;
    const worker = new AgentWorker({
      runtime: this,
      definition,
      cursors: this.#cursors,
      cwd: definition.cwd ?? this.#cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
      maxRebaseAttempts: this.#maxRebaseAttempts,
      maxReconciliationPasses: this.#maxReconciliationPasses,
      maxReconciliationDeltaEvents: this.#maxReconciliationDeltaEvents,
      reconciliationQuietWindowMs: this.#reconciliationQuietWindowMs,
    });
    this.#workers.set(agentId, worker);
    try {
      await worker.start();
    } catch (error) {
      this.#workers.delete(agentId);
      throw error;
    }
  }

  async stopAgent(agentId: ParticipantId): Promise<void> {
    const worker = this.#workers.get(agentId);
    if (worker === undefined) {
      return;
    }
    await worker.stop();
    if (!worker.sessionId.startsWith("pending:")) {
      this.#sessionIds.set(agentId, worker.sessionId);
    }
    this.#workers.delete(agentId);
  }

  async restartAgent(agentId: ParticipantId): Promise<void> {
    await this.stopAgent(agentId);
    await this.startAgent(agentId);
  }

  wakeAgent(agentId: ParticipantId): void {
    const worker = this.#workers.get(agentId);
    if (worker === undefined) {
      throw new Error(`Agent ${agentId} is not running.`);
    }
    worker.wake();
  }

  steerAgent(agentId: ParticipantId, text: string): RoomEvent<RoomMessagePayload> {
    this.#requireDefinition(agentId);
    return this.postMessage({ text, attention: [agentId] });
  }

  postMessage(input: PostMessageInput): RoomEvent<RoomMessagePayload> {
    this.#assertOpen();
    const text = input.text.trim();
    if (text.length === 0) {
      throw new Error("A room message cannot be empty.");
    }
    const subject: SubjectRef = Object.freeze({
      kind: "thread",
      id: input.threadId ?? this.defaultThread.id,
    });
    const idempotencyKey = input.idempotencyKey ?? `message:${randomUUID()}`;
    const result = this.room.commit<RoomMessagePayload>({
      id: idempotencyKey,
      idempotencyKey,
      roomId: this.room.roomId,
      actorId: input.actorId ?? this.humanId,
      subject,
      action: CoreAction.threadMessageAppend,
      payload: Object.freeze({
        kind: "message",
        text,
        attention: freezeAttention(input.attention ?? "team"),
        respondingTo: Object.freeze([...(input.respondingTo ?? [])]),
      }),
    });
    return requireCommitted(result).event;
  }

  createTask(input: CreateTaskInput): RoomEvent<TaskCreatedPayload> {
    this.#assertOpen();
    const taskId = input.id ?? randomUUID();
    const subject: SubjectRef = { kind: "task", id: taskId };
    const idempotencyKey = input.idempotencyKey ?? `task:create:${taskId}`;
    const result = this.room.commit<TaskCreatedPayload>({
      id: idempotencyKey,
      idempotencyKey,
      roomId: this.room.roomId,
      actorId: input.actorId ?? this.humanId,
      subject,
      action: CoreAction.taskCreate,
      payload: Object.freeze({
        kind: "task-created",
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        status: "todo",
      }),
    });
    return requireCommitted(result).event;
  }

  claimTask(
    taskId: string,
    ownerId: ParticipantId,
    options: { readonly actorId?: ParticipantId; readonly idempotencyKey?: string } = {},
  ): CommitResult<TaskClaimedPayload> {
    this.#assertOpen();
    const subject: SubjectRef = { kind: "task", id: taskId };
    const idempotencyKey = options.idempotencyKey ?? `task:claim:${taskId}:${ownerId}`;
    return this.room.commit<TaskClaimedPayload>({
      id: idempotencyKey,
      idempotencyKey,
      roomId: this.room.roomId,
      actorId: options.actorId ?? ownerId,
      subject,
      action: CoreAction.taskClaim,
      payload: Object.freeze({ kind: "task-claimed", ownerId }),
      basedOn: [{ subject, version: this.room.currentVersion(subject) }],
    });
  }

  updateTask(input: UpdateTaskInput): CommitResult<TaskUpdatedPayload> {
    this.#assertOpen();
    const subject: SubjectRef = { kind: "task", id: input.taskId };
    const idempotencyKey = input.idempotencyKey ?? `task:update:${input.taskId}:${randomUUID()}`;
    return this.room.commit<TaskUpdatedPayload>({
      id: idempotencyKey,
      idempotencyKey,
      roomId: this.room.roomId,
      actorId: input.actorId ?? this.humanId,
      subject,
      action: CoreAction.taskUpdate,
      payload: Object.freeze({
        kind: "task-updated",
        status: input.status,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
      basedOn: [{ subject, version: this.room.currentVersion(subject) }],
    });
  }

  snapshot(): RoomSnapshot {
    const events = this.room.readEvents();
    return projectRoom(
      this.room.roomId,
      events,
      [...this.#definitions.values()].map((definition) =>
        Object.freeze({
          id: definition.id,
          name: definition.name,
          handle: definition.handle,
          adapterKind: definition.adapter.kind,
          ...(definition.sessionId === undefined ? {} : { sessionId: definition.sessionId }),
        }),
      ),
      this.#sessionIds,
      this.#traces.read(),
    );
  }

  recordTrace(
    input: Omit<TraceRecordInput, "id" | "roomId" | "occurredAt"> & {
      readonly id?: string;
      readonly occurredAt?: number;
    },
  ): TraceRecord {
    this.#assertOpen();
    const trace = this.#traces.append({
      ...input,
      id: input.id ?? `trace:${randomUUID()}`,
      roomId: this.room.roomId,
      occurredAt: input.occurredAt ?? Date.now(),
    });
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      listener(snapshot, undefined);
    }
    return trace;
  }

  subscribe(listener: SnapshotListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async settle(): Promise<void> {
    for (let pass = 0; pass < 50; pass += 1) {
      const headBefore = this.room.headSequence;
      await Promise.all([...this.#workers.values()].map((worker) => worker.settle()));
      await new Promise<void>((resolveWait) => setImmediate(resolveWait));
      if (headBefore === this.room.headSequence) {
        await Promise.all([...this.#workers.values()].map((worker) => worker.settle()));
        if (headBefore === this.room.headSequence) {
          return;
        }
      }
    }
    throw new Error("Collaboration runtime did not settle after 50 passes.");
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    await Promise.all([...this.#workers.keys()].map((agentId) => this.stopAgent(agentId)));
    this.#unsubscribeRoom();
    this.#listeners.clear();
    this.#closed = true;
  }

  participantHandles(): ReadonlyMap<string, ParticipantId> {
    return new Map(this.#handles);
  }

  participantLabel(participantId: ParticipantId): string {
    if (participantId === this.humanId) {
      return `@${this.#humanHandle}`;
    }
    const definition = this.#definitions.get(participantId);
    return definition === undefined ? participantId : `@${definition.handle}`;
  }

  classifyTurnChange(event: RoomEvent, context: TurnChangeContext): TurnChangeImpact {
    return this.#classifyTurnChange(event, context);
  }

  commitPresence(
    agentId: ParticipantId,
    state: ParticipantPresence,
    details: {
      readonly adapterKind: string;
      readonly sessionId?: string;
      readonly detail?: string;
    },
  ): RoomEvent<PresencePayload> {
    const key = `presence:${agentId}:${state}:${randomUUID()}`;
    const result = this.room.commit<PresencePayload>({
      id: key,
      idempotencyKey: key,
      roomId: this.room.roomId,
      actorId: agentId,
      subject: { kind: "participant", id: agentId },
      action: CoreAction.participantPresenceSet,
      payload: Object.freeze({
        kind: "presence",
        state,
        adapterKind: details.adapterKind,
        ...(details.sessionId === undefined ? {} : { sessionId: details.sessionId }),
        ...(details.detail === undefined ? {} : { detail: details.detail }),
      }),
    });
    return requireCommitted(result).event;
  }

  #requireDefinition(agentId: ParticipantId): AgentDefinition {
    const definition = this.#definitions.get(agentId);
    if (definition === undefined) {
      throw new Error(`Agent ${agentId} is not registered.`);
    }
    return definition;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Collaboration runtime is closed.");
    }
  }
}

interface AgentWorkerOptions {
  readonly runtime: CollaborationRuntime;
  readonly definition: AgentDefinition;
  readonly cursors: CursorStore;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly maxRebaseAttempts: number;
  readonly maxReconciliationPasses: number;
  readonly maxReconciliationDeltaEvents: number;
  readonly reconciliationQuietWindowMs: number;
}

interface TurnTraceContext {
  readonly turnId: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly triggerIds: readonly EventId[];
  readonly observedVersion: number;
  basisVersion: number;
  readonly startedAt: number;
  readonly changes: RoomEvent[];
  reconciliationPasses: number;
  endedAt?: number;
}

type CandidatePreparation =
  | { readonly kind: "ready"; readonly candidate: CandidateState }
  | {
      readonly kind: "regenerate";
      readonly candidate: CandidateState;
      readonly currentVersion: number;
      readonly reason: string;
    }
  | { readonly kind: "drop"; readonly reason: string };

class AgentWorker {
  readonly #runtime: CollaborationRuntime;
  readonly #definition: AgentDefinition;
  readonly #inbox: ParticipantInbox;
  readonly #cwd: string;
  readonly #initialSessionId: string | undefined;
  readonly #maxRebaseAttempts: number;
  readonly #maxReconciliationPasses: number;
  readonly #maxReconciliationDeltaEvents: number;
  readonly #reconciliationQuietWindowMs: number;
  #session: AgentSession | undefined;
  #unsubscribeWake: Unsubscribe | undefined;
  #unsubscribeRoomChanges: Unsubscribe | undefined;
  #work: Promise<void> = Promise.resolve();
  #stopping = false;
  #failed = false;
  #lastSessionStatus: AgentSessionStatus | undefined;
  #lastSessionStatusAt: number | undefined;
  readonly #draftBuffers = new Map<string, string>();
  readonly #turnTraceContexts = new Map<string, TurnTraceContext>();
  #activeTurnTraceContext: TurnTraceContext | undefined;

  constructor(options: AgentWorkerOptions) {
    this.#runtime = options.runtime;
    this.#definition = options.definition;
    this.#cwd = options.cwd;
    this.#initialSessionId = options.sessionId;
    this.#maxRebaseAttempts = options.maxRebaseAttempts;
    this.#maxReconciliationPasses = options.maxReconciliationPasses;
    this.#maxReconciliationDeltaEvents = options.maxReconciliationDeltaEvents;
    this.#reconciliationQuietWindowMs = options.reconciliationQuietWindowMs;
    this.#inbox = new ParticipantInbox(
      this.#runtime.room,
      options.cursors,
      this.#definition.id,
      { subscriptionId: "agent-room-context" },
    );
  }

  get sessionId(): string {
    return this.#session?.id ?? this.#initialSessionId ?? `pending:${this.#definition.id}`;
  }

  async start(): Promise<void> {
    this.#runtime.recordTrace({
      actorId: this.#definition.id,
      kind: "agent.session.starting",
      status: "running",
      detail: this.#definition.adapter.kind,
    });
    this.#runtime.commitPresence(this.#definition.id, "starting", {
      adapterKind: this.#definition.adapter.kind,
      ...(this.#initialSessionId === undefined ? {} : { sessionId: this.#initialSessionId }),
    });
    let session: AgentSession;
    try {
      session = await this.#definition.adapter.start({
        agentId: this.#definition.id,
        cwd: this.#cwd,
        ...(this.#initialSessionId === undefined ? {} : { sessionId: this.#initialSessionId }),
        systemPrompt: buildSystemPrompt(this.#runtime, this.#definition),
        permissionPolicy: this.#definition.permissionPolicy ?? "deny",
      });
    } catch (error) {
      this.#failed = true;
      this.#activeTurnTraceContext = undefined;
      this.#runtime.recordTrace({
        actorId: this.#definition.id,
        kind: "agent.session.failed",
        status: "failed",
        detail: errorMessage(error),
      });
      this.#runtime.commitPresence(this.#definition.id, "error", {
        adapterKind: this.#definition.adapter.kind,
        ...(this.#initialSessionId === undefined ? {} : { sessionId: this.#initialSessionId }),
        detail: errorMessage(error),
      });
      throw error;
    }
    const readyAt = Date.now();
    this.#session = session;
    this.#lastSessionStatus = session.status;
    this.#lastSessionStatusAt = readyAt;
    this.#unsubscribeWake = this.#inbox.subscribeToWakeHints(() => this.wake());
    this.#unsubscribeRoomChanges = this.#runtime.room.subscribe((notification) => {
      this.#observeRoomChange(notification.event);
    });
    this.#runtime.commitPresence(this.#definition.id, "idle", {
      adapterKind: this.#definition.adapter.kind,
      sessionId: session.id,
    });
    this.#runtime.recordTrace({
      actorId: this.#definition.id,
      kind: "agent.session.ready",
      status: "completed",
      occurredAt: readyAt,
      detail: session.id,
      data: Object.freeze({ capabilities: session.capabilities }),
    });
    void this.#forwardSessionEvents(session);
    this.wake();
  }

  wake(): void {
    if (this.#stopping || this.#failed) {
      return;
    }
    this.#work = this.#work.then(
      () => this.#drain(),
      () => this.#drain(),
    );
  }

  async settle(): Promise<void> {
    for (;;) {
      const pending = this.#work;
      await pending;
      if (pending === this.#work) {
        return;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    const stoppingSessionId = this.#session?.id ?? this.#initialSessionId;
    this.#runtime.recordTrace({
      actorId: this.#definition.id,
      kind: "agent.session.stopping",
      status: "running",
      ...(stoppingSessionId === undefined ? {} : { detail: stoppingSessionId }),
    });
    this.#unsubscribeWake?.();
    this.#unsubscribeWake = undefined;
    this.#unsubscribeRoomChanges?.();
    this.#unsubscribeRoomChanges = undefined;
    const session = this.#session;
    if (session !== undefined) {
      if (session.status === "working") {
        await session.cancel();
      }
      try {
        await this.settle();
      } catch {
        // A failed turn is already represented by durable error presence. It
        // must not prevent lifecycle cleanup or an explicit restart.
      }
      await session.stop();
    }
    this.#runtime.commitPresence(this.#definition.id, "offline", {
      adapterKind: this.#definition.adapter.kind,
      ...(session === undefined ? {} : { sessionId: session.id }),
    });
    this.#runtime.recordTrace({
      actorId: this.#definition.id,
      kind: "agent.session.stopped",
      status: "completed",
      ...(session === undefined ? {} : { detail: session.id }),
    });
  }

  async #drain(): Promise<void> {
    const session = this.#session;
    if (session === undefined || this.#stopping || this.#failed) {
      return;
    }

    let batch = this.#inbox.pull();
    if (batch.scannedThrough === batch.afterCursor) {
      return;
    }
    let triggers = actionableEvents(
      batch.events,
      this.#definition.id,
      this.#definition.respondToTeam ?? true,
      this.#runtime.defaultThread,
    );
    if (triggers.length === 0) {
      this.#inbox.acknowledge(batch);
      return;
    }
    const uncovered = triggers.filter(
      (trigger) => !hasHandledTrigger(this.#runtime.room, this.#definition.id, trigger.id),
    );
    if (uncovered.length === 0) {
      this.#inbox.acknowledge(batch);
      return;
    }
    triggers = uncovered;

    let activeTurnId: string | undefined;
    let activeCorrelationId: string | undefined;
    let activeAttempt: number | undefined;
    let activeTriggerIds: readonly EventId[] = Object.freeze([]);
    let retryOfTurnId: string | undefined;
    try {
      attemptLoop: for (let attempt = 1; attempt <= this.#maxRebaseAttempts; attempt += 1) {
        if (attempt > 1) {
          batch = this.#inbox.pull();
          triggers = actionableEvents(
            batch.events,
            this.#definition.id,
            this.#definition.respondToTeam ?? true,
            this.#runtime.defaultThread,
          ).filter(
            (trigger) => !hasHandledTrigger(this.#runtime.room, this.#definition.id, trigger.id),
          );
          if (triggers.length === 0) {
            this.#inbox.acknowledge(batch);
            return;
          }
        }

        const observedVersion = this.#runtime.room.currentVersion(this.#runtime.defaultThread);
        this.#runtime.commitPresence(this.#definition.id, "working", {
          adapterKind: this.#definition.adapter.kind,
          sessionId: session.id,
          detail: `Responding to ${String(triggers.length)} room event(s).`,
        });
        const triggerIds = triggers.map((event) => event.id);
        const turnId = turnKey(this.#definition.id, triggerIds, observedVersion);
        const correlationId = collaborationKey(triggerIds);
        const startedAt = Date.now();
        const traceContext: TurnTraceContext = {
          turnId,
          correlationId,
          attempt,
          triggerIds: Object.freeze([...triggerIds]),
          observedVersion,
          basisVersion: observedVersion,
          startedAt,
          changes: [],
          reconciliationPasses: 0,
        };
        this.#turnTraceContexts.set(turnId, traceContext);
        this.#activeTurnTraceContext = traceContext;
        activeTurnId = turnId;
        activeCorrelationId = correlationId;
        activeAttempt = attempt;
        activeTriggerIds = Object.freeze([...triggerIds]);
        this.#draftBuffers.set(turnId, "");
        this.#runtime.recordTrace({
          id: `trace:${turnId}:started`,
          actorId: this.#definition.id,
          kind: "agent.turn.started",
          status: "running",
          occurredAt: startedAt,
          correlationId,
          turnId,
          attempt,
          detail: `Observing thread version ${String(observedVersion)}.`,
          data: Object.freeze({
            triggerIds: Object.freeze([...triggerIds]),
            observedVersion,
            inboxAfterCursor: batch.afterCursor,
            inboxScannedThrough: batch.scannedThrough,
            ...(retryOfTurnId === undefined ? {} : { retryOfTurnId }),
          }),
        });
        const result = await session.prompt({
          turnId,
          text: buildRoomPrompt(
            this.#runtime,
            this.#definition,
            batch,
            triggerIds,
            attempt,
          ),
        });
        const resultAt = Date.now();
        traceContext.endedAt = resultAt;
        this.#draftBuffers.delete(turnId);

        const hasDraft = result.text.length > 0;
        this.#runtime.recordTrace({
          id: `trace:${turnId}:result`,
          actorId: this.#definition.id,
          kind: hasDraft ? "agent.draft.generated" : "agent.turn.result",
          status:
            result.stopReason === "completed" && hasDraft
              ? "pending"
              : traceStatusForStopReason(result.stopReason),
          occurredAt: resultAt,
          correlationId,
          turnId,
          attempt,
          ...(hasDraft ? { content: result.text } : {}),
          detail: result.stopReason,
          data: Object.freeze({
            triggerIds: Object.freeze([...triggerIds]),
            observedVersion,
            durationMs: resultAt - startedAt,
            ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
          }),
        });

        let replyEvent: RoomEvent<RoomMessagePayload> | undefined;
        let candidateText = result.text;
        if (result.stopReason === "completed" && candidateText.trim().length > 0) {
          let candidate: CandidateState = Object.freeze({
            text: candidateText,
            basedOnVersion: observedVersion,
          });
          for (;;) {
            const preparation = await this.#prepareCandidate(session, traceContext, candidate);
            if (preparation.kind === "regenerate") {
              this.#runtime.recordTrace({
                id: `trace:${turnId}:expired`,
                actorId: this.#definition.id,
                kind: "agent.draft.expired",
                status: "expired",
                correlationId,
                turnId,
                attempt,
                content: preparation.candidate.text,
                detail: preparation.reason,
                data: Object.freeze({
                  triggerIds: Object.freeze([...triggerIds]),
                  observedVersion: preparation.candidate.basedOnVersion,
                  currentVersion: preparation.currentVersion,
                  durationMs: Date.now() - startedAt,
                  changeEventIds: Object.freeze(traceContext.changes.map((event) => event.id)),
                }),
              });
              retryOfTurnId = turnId;
              this.#activeTurnTraceContext = undefined;
              continue attemptLoop;
            }
            if (preparation.kind === "drop") {
              candidateText = "";
              break;
            }
            candidate = preparation.candidate;
            candidateText = candidate.text;
            const payload = responsePayload(
              candidate.text,
              triggerIds,
              this.#runtime.participantHandles(),
              this.#runtime.humanId,
            );
            const key = `reply:${turnId}:basis:${String(candidate.basedOnVersion)}`;
            const commit = this.#runtime.room.commit<RoomMessagePayload>({
              id: key,
              idempotencyKey: key,
              roomId: this.#runtime.room.roomId,
              actorId: this.#definition.id,
              subject: this.#runtime.defaultThread,
              action: CoreAction.threadReplyCommit,
              payload,
              basedOn: [{
                subject: this.#runtime.defaultThread,
                version: candidate.basedOnVersion,
              }],
            });
            if (commit.status === "needs_rebase") {
              continue;
            }
            replyEvent = requireCommitted(commit).event;
            this.#runtime.recordTrace({
              id: `trace:${turnId}:committed`,
              actorId: this.#definition.id,
              kind: "agent.draft.committed",
              status: "committed",
              correlationId,
              turnId,
              attempt,
              content: candidate.text,
              detail: `Committed as room event ${replyEvent.id}.`,
              data: Object.freeze({
                triggerIds: Object.freeze([...triggerIds]),
                replyEventId: replyEvent.id,
                roomSequence: replyEvent.sequence,
                observedVersion,
                validatedVersion: candidate.basedOnVersion,
                reconciliationPasses: traceContext.reconciliationPasses,
              }),
            });
            break;
          }
        }

        const outcome = turnOutcome(result.stopReason, replyEvent !== undefined);
        this.#activeTurnTraceContext = undefined;
        this.#commitReceipt(triggerIds, outcome, replyEvent?.id);
        const completedAt = Date.now();
        this.#runtime.recordTrace({
          id: `trace:${turnId}:completed`,
          actorId: this.#definition.id,
          kind: "agent.turn.completed",
          status: traceStatusForOutcome(outcome),
          occurredAt: completedAt,
          correlationId,
          turnId,
          attempt,
          detail: outcome,
          data: Object.freeze({
            triggerIds: Object.freeze([...triggerIds]),
            observedVersion,
            finalBasisVersion: traceContext.basisVersion,
            reconciliationPasses: traceContext.reconciliationPasses,
            durationMs: completedAt - startedAt,
            ...(replyEvent === undefined ? {} : { replyEventId: replyEvent.id }),
          }),
        });
        this.#inbox.acknowledge(batch);
        this.#runtime.commitPresence(this.#definition.id, "waiting", {
          adapterKind: this.#definition.adapter.kind,
          sessionId: session.id,
        });
        return;
      }
      throw new Error(
        `${this.#definition.id} could not commit a state-aware reply after ${String(this.#maxRebaseAttempts)} rebases.`,
      );
    } catch (error) {
      this.#failed = true;
      const partialDraft =
        activeTurnId === undefined ? undefined : this.#draftBuffers.get(activeTurnId);
      if (activeTurnId !== undefined) {
        this.#draftBuffers.delete(activeTurnId);
      }
      this.#runtime.recordTrace({
        actorId: this.#definition.id,
        kind: "agent.turn.failed",
        status: "failed",
        ...(activeCorrelationId === undefined ? {} : { correlationId: activeCorrelationId }),
        ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
        ...(activeAttempt === undefined ? {} : { attempt: activeAttempt }),
        ...(partialDraft === undefined || partialDraft.length === 0
          ? {}
          : { content: partialDraft }),
        detail: errorMessage(error),
        data: Object.freeze({ triggerIds: activeTriggerIds }),
      });
      this.#runtime.commitPresence(this.#definition.id, "error", {
        adapterKind: this.#definition.adapter.kind,
        sessionId: session.id,
        detail: errorMessage(error),
      });
      throw error;
    }
  }

  async #prepareCandidate(
    session: AgentSession,
    context: TurnTraceContext,
    candidate: CandidateState,
  ): Promise<CandidatePreparation> {
    let targetVersion = this.#runtime.room.currentVersion(this.#runtime.defaultThread);
    if (targetVersion === candidate.basedOnVersion) {
      return Object.freeze({ kind: "ready", candidate });
    }
    if (this.#reconciliationQuietWindowMs > 0) {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, this.#reconciliationQuietWindowMs);
      });
      targetVersion = this.#runtime.room.currentVersion(this.#runtime.defaultThread);
    }

    const changes = this.#runtime.room.readEvents().filter(
      (event) =>
        sameSubject(event.subject, this.#runtime.defaultThread) &&
        event.subjectVersion > candidate.basedOnVersion &&
        event.subjectVersion <= targetVersion,
    );
    for (const change of changes) {
      this.#observeRoomChange(change);
    }
    const classified = changes.map((event) => Object.freeze({
      event,
      impact: this.#runtime.classifyTurnChange(event, {
        agentId: this.#definition.id,
        subject: this.#runtime.defaultThread,
        basedOnVersion: candidate.basedOnVersion,
        triggerIds: context.triggerIds,
      }),
    }));
    const relevant = classified.filter(({ impact }) => impact !== "irrelevant");
    if (relevant.length === 0) {
      context.basisVersion = targetVersion;
      this.#discardBufferedChangesThrough(context, targetVersion);
      this.#runtime.recordTrace({
        id: `trace:${context.turnId}:reconciliation:auto:${String(targetVersion)}`,
        actorId: this.#definition.id,
        kind: "agent.reconciliation.decided",
        status: "completed",
        correlationId: context.correlationId,
        turnId: context.turnId,
        attempt: context.attempt,
        detail: "keep",
        data: Object.freeze({
          decision: "keep",
          reason: "All intervening changes were classified as irrelevant.",
          basedOnVersion: candidate.basedOnVersion,
          targetVersion,
          changeEventIds: Object.freeze(changes.map((event) => event.id)),
          automatic: true,
        }),
      });
      return Object.freeze({
        kind: "ready",
        candidate: Object.freeze({ text: candidate.text, basedOnVersion: targetVersion }),
      });
    }

    if (relevant.length > this.#maxReconciliationDeltaEvents) {
      const reason =
        `Room delta contains ${String(relevant.length)} relevant events, exceeding the ` +
        `${String(this.#maxReconciliationDeltaEvents)} event review limit.`;
      this.#runtime.recordTrace({
        id: `trace:${context.turnId}:reconciliation:overflow:${String(targetVersion)}`,
        actorId: this.#definition.id,
        kind: "agent.reconciliation.decided",
        status: "expired",
        correlationId: context.correlationId,
        turnId: context.turnId,
        attempt: context.attempt,
        detail: "regenerate",
        data: Object.freeze({
          decision: "regenerate",
          reason,
          basedOnVersion: candidate.basedOnVersion,
          targetVersion,
          changeEventIds: Object.freeze(relevant.map(({ event }) => event.id)),
          deltaOverflow: true,
        }),
      });
      return Object.freeze({
        kind: "regenerate",
        candidate,
        currentVersion: targetVersion,
        reason,
      });
    }

    if (context.reconciliationPasses >= this.#maxReconciliationPasses) {
      const reason = `Reconciliation limit ${String(this.#maxReconciliationPasses)} reached.`;
      this.#runtime.recordTrace({
        id: `trace:${context.turnId}:reconciliation:limit:${String(targetVersion)}`,
        actorId: this.#definition.id,
        kind: "agent.reconciliation.decided",
        status: "expired",
        correlationId: context.correlationId,
        turnId: context.turnId,
        attempt: context.attempt,
        detail: "regenerate",
        data: Object.freeze({
          decision: "regenerate",
          reason,
          basedOnVersion: candidate.basedOnVersion,
          targetVersion,
          changeEventIds: Object.freeze(relevant.map(({ event }) => event.id)),
        }),
      });
      return Object.freeze({
        kind: "regenerate",
        candidate,
        currentVersion: targetVersion,
        reason,
      });
    }

    context.reconciliationPasses += 1;
    const pass = context.reconciliationPasses;
    const reconciliationStartedAt = Date.now();
    this.#runtime.recordTrace({
      id: `trace:${context.turnId}:reconciliation:${String(pass)}:started`,
      actorId: this.#definition.id,
      kind: "agent.reconciliation.started",
      status: "running",
      occurredAt: reconciliationStartedAt,
      correlationId: context.correlationId,
      turnId: context.turnId,
      attempt: context.attempt,
      detail: `Reviewing ${String(relevant.length)} relevant room change(s).`,
      data: Object.freeze({
        pass,
        basedOnVersion: candidate.basedOnVersion,
        targetVersion,
        changeEventIds: Object.freeze(relevant.map(({ event }) => event.id)),
        impacts: Object.freeze(relevant.map(({ event, impact }) => Object.freeze({
          eventId: event.id,
          impact,
        }))),
      }),
    });

    delete context.endedAt;
    this.#draftBuffers.set(context.turnId, "");
    const review = await session.prompt({
      turnId: context.turnId,
      text: buildReconciliationPrompt(
        candidate,
        relevant.map(({ event, impact }) => Object.freeze({ event, impact })),
        targetVersion,
      ),
    });
    const reconciliationEndedAt = Date.now();
    context.endedAt = reconciliationEndedAt;
    this.#draftBuffers.delete(context.turnId);
    const parsed = review.stopReason === "completed"
      ? parseReconciliation(review.text)
      : undefined;
    const decision: ParsedReconciliation = parsed ?? Object.freeze({
      decision: "regenerate",
      reason: review.stopReason === "completed"
        ? "The reconciliation response was not valid JSON."
        : `The reconciliation turn ended with ${review.stopReason}.`,
    });
    const status: TraceRecord["status"] =
      decision.decision === "regenerate"
        ? "expired"
        : decision.decision === "drop"
          ? "cancelled"
          : "completed";
    this.#runtime.recordTrace({
      id: `trace:${context.turnId}:reconciliation:${String(pass)}:decided`,
      actorId: this.#definition.id,
      kind: "agent.reconciliation.decided",
      status,
      occurredAt: reconciliationEndedAt,
      correlationId: context.correlationId,
      turnId: context.turnId,
      attempt: context.attempt,
      ...(decision.text === undefined ? {} : { content: decision.text }),
      detail: decision.decision,
      data: Object.freeze({
        pass,
        decision: decision.decision,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        basedOnVersion: candidate.basedOnVersion,
        targetVersion,
        changeEventIds: Object.freeze(relevant.map(({ event }) => event.id)),
        durationMs: reconciliationEndedAt - reconciliationStartedAt,
        rawResponse: review.text,
      }),
    });

    if (decision.decision === "regenerate") {
      return Object.freeze({
        kind: "regenerate",
        candidate,
        currentVersion: targetVersion,
        reason: decision.reason ?? "The candidate requires full regeneration.",
      });
    }
    if (decision.decision === "drop") {
      return Object.freeze({
        kind: "drop",
        reason: decision.reason ?? "The latest room state no longer needs this reply.",
      });
    }

    context.basisVersion = targetVersion;
    this.#discardBufferedChangesThrough(context, targetVersion);
    return Object.freeze({
      kind: "ready",
      candidate: Object.freeze({
        text: decision.decision === "patch" ? decision.text ?? candidate.text : candidate.text,
        basedOnVersion: targetVersion,
      }),
    });
  }

  #discardBufferedChangesThrough(context: TurnTraceContext, version: number): void {
    for (let index = context.changes.length - 1; index >= 0; index -= 1) {
      const change = context.changes[index];
      if (
        change !== undefined &&
        sameSubject(change.subject, this.#runtime.defaultThread) &&
        change.subjectVersion <= version
      ) {
        context.changes.splice(index, 1);
      }
    }
  }

  #commitReceipt(
    triggerIds: readonly EventId[],
    outcome: AgentTurnCompletedPayload["outcome"],
    replyEventId: EventId | undefined,
  ): void {
    const key = `turn-receipt:${this.#definition.id}:${stableId(triggerIds)}`;
    const result = this.#runtime.room.commit<AgentTurnCompletedPayload>({
      id: key,
      idempotencyKey: key,
      roomId: this.#runtime.room.roomId,
      actorId: this.#definition.id,
      subject: { kind: "participant", id: this.#definition.id },
      action: CoreAction.agentTurnComplete,
      payload: Object.freeze({
        kind: "agent-turn-completed",
        respondingTo: Object.freeze([...triggerIds]),
        outcome,
        ...(replyEventId === undefined ? {} : { replyEventId }),
      }),
    });
    requireCommitted(result);
  }

  #observeRoomChange(event: RoomEvent): void {
    const context = this.#activeTurnTraceContext;
    if (context === undefined || event.actorId === this.#definition.id) {
      return;
    }
    const impact = this.#runtime.classifyTurnChange(event, {
      agentId: this.#definition.id,
      subject: this.#runtime.defaultThread,
      basedOnVersion: context.basisVersion,
      triggerIds: context.triggerIds,
    });
    if (impact === "irrelevant") {
      return;
    }
    if (context.changes.some((change) => change.id === event.id)) {
      return;
    }
    context.changes.push(event);
    this.#runtime.recordTrace({
      id: `trace:${context.turnId}:dirty:${event.id}`,
      actorId: this.#definition.id,
      kind: "agent.turn.dirty",
      status: "dirty",
      correlationId: context.correlationId,
      turnId: context.turnId,
      attempt: context.attempt,
      detail: impact,
      data: Object.freeze({
        impact,
        changeEventId: event.id,
        roomSequence: event.sequence,
        action: event.action,
        basedOnVersion: context.basisVersion,
        currentVersion: event.subjectVersion,
      }),
    });
  }

  async #forwardSessionEvents(session: AgentSession): Promise<void> {
    try {
      for await (const event of session.events()) {
        if (this.#stopping) {
          return;
        }
        switch (event.type) {
          case "status": {
            const previousStatus = this.#lastSessionStatus;
            const previousStatusAt = this.#lastSessionStatusAt;
            this.#lastSessionStatus = event.status;
            this.#lastSessionStatusAt = event.at;
            const context = this.#turnTraceContextAt(event.at);
            this.#runtime.recordTrace({
              actorId: this.#definition.id,
              kind: "agent.session.status",
              status: traceStatusForSessionStatus(event.status),
              occurredAt: event.at,
              ...(context === undefined ? {} : {
                correlationId: context.correlationId,
                turnId: context.turnId,
                attempt: context.attempt,
              }),
              detail: `${previousStatus ?? "unknown"} -> ${event.status}`,
              data: Object.freeze({
                sessionId: session.id,
                ...(previousStatus === undefined ? {} : { fromStatus: previousStatus }),
                toStatus: event.status,
                ...(previousStatusAt === undefined
                  ? {}
                  : { statusDurationMs: Math.max(0, event.at - previousStatusAt) }),
                ...(context === undefined ? {} : {
                  triggerIds: context.triggerIds,
                  observedVersion: context.observedVersion,
                }),
              }),
            });
            break;
          }
          case "text-delta": {
            const buffered = this.#draftBuffers.get(event.turnId);
            if (buffered !== undefined) {
              this.#draftBuffers.set(event.turnId, buffered + event.delta);
            }
            break;
          }
          case "tool-call":
            const context = this.#turnTraceContexts.get(event.turnId);
            this.#runtime.recordTrace({
              actorId: this.#definition.id,
              kind: `agent.tool.${event.status}`,
              status: traceStatusForToolCall(event.status),
              occurredAt: event.at,
              ...(context === undefined ? {} : {
                correlationId: context.correlationId,
                attempt: context.attempt,
              }),
              turnId: event.turnId,
              detail: event.title,
              data: Object.freeze({
                sessionId: session.id,
                ...(context === undefined ? {} : {
                  triggerIds: context.triggerIds,
                  observedVersion: context.observedVersion,
                }),
                ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
              }),
            });
            break;
          case "error":
            this.#runtime.recordTrace({
              actorId: this.#definition.id,
              kind: "agent.session.error",
              status: "failed",
              occurredAt: event.at,
              detail: event.message,
              data: Object.freeze({ sessionId: session.id }),
            });
            this.#runtime.commitPresence(this.#definition.id, "error", {
              adapterKind: this.#definition.adapter.kind,
              sessionId: session.id,
              detail: event.message,
            });
            break;
        }
      }
    } catch {
      // The worker's prompt/start/stop paths own durable lifecycle reporting.
    }
  }

  #turnTraceContextAt(timestamp: number): TurnTraceContext | undefined {
    const contexts = [...this.#turnTraceContexts.values()];
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const context = contexts[index];
      if (
        context !== undefined &&
        timestamp >= context.startedAt &&
        (context.endedAt === undefined || timestamp <= context.endedAt)
      ) {
        return context;
      }
    }
    return undefined;
  }
}

function buildSystemPrompt(runtime: CollaborationRuntime, definition: AgentDefinition): string {
  const participants = [...runtime.participantHandles().entries()]
    .filter(([handle]) => handle !== normalizeHandle(definition.id))
    .map(([handle, id]) => `@${handle} (${id})`)
    .join(", ");
  return [
    `You are ${definition.name} (${definition.id}) inside a Mesh collaboration room.`,
    "The room is shared: humans and all agents can read the same canonical event history.",
    "You decide independently when addressed; there is no central speaker scheduler.",
    `Available participants: ${participants}.`,
    "In your final response, use @handle to direct attention to the next participant, or @human to return to the human.",
    "Do not wrap the response in a JSON protocol object. Keep factual room state separate from private reasoning.",
    "Exception: a prompt headed MESH INTERNAL RECONCILIATION is not a room response; follow its exact JSON schema.",
    ...(definition.systemPrompt === undefined ? [] : [definition.systemPrompt]),
  ].join("\n");
}

function buildRoomPrompt(
  runtime: CollaborationRuntime,
  definition: AgentDefinition,
  batch: InboxBatch,
  triggerIds: readonly EventId[],
  attempt: number,
): string {
  const events = runtime.room.readEvents().map(formatEvent).join("\n");
  return [
    `ROOM ${runtime.room.roomId} UPDATE (sequences ${String(batch.afterCursor + 1)}-${String(batch.scannedThrough)})`,
    `Your identity: ${definition.id} (${runtime.participantLabel(definition.id)})`,
    `Events requiring your attention: ${triggerIds.join(", ")}`,
    ...(attempt === 1
      ? []
      : ["The room changed during your previous reasoning. Re-evaluate against this latest event stream."]),
    "The block below is the complete canonical room history; events after your durable cursor are the new delta.",
    "<room-events-jsonl>",
    events,
    "</room-events-jsonl>",
    "Respond to the latest shared state. Use a known @handle to hand off, or @human when the human should receive the result.",
  ].join("\n");
}

function formatEvent(event: RoomEvent): string {
  return JSON.stringify({
    eventId: event.id,
    sequence: event.sequence,
    actorId: event.actorId,
    subject: event.subject,
    subjectVersion: event.subjectVersion,
    action: event.action,
    payload: event.payload,
    committedAt: event.committedAt,
  });
}

function actionableEvents(
  events: readonly RoomEvent[],
  participantId: ParticipantId,
  respondToTeam: boolean,
  thread: SubjectRef,
): RoomEvent<RoomMessagePayload>[] {
  return events.filter((event): event is RoomEvent<RoomMessagePayload> => {
    if (
      event.actorId === participantId ||
      !sameSubject(event.subject, thread) ||
      !isMessageEvent(event)
    ) {
      return false;
    }
    return event.payload.attention === "team"
      ? respondToTeam
      : event.payload.attention.includes(participantId);
  });
}

function hasHandledTrigger(room: RoomLedger, agentId: ParticipantId, eventId: EventId): boolean {
  return room.readEvents().some((event) => {
    if (event.actorId !== agentId) {
      return false;
    }
    const payload = event.payload;
    if (isMessageEvent(event)) {
      return event.payload.respondingTo.includes(eventId);
    }
    return (
      event.action === CoreAction.agentTurnComplete &&
      isRecord(payload) &&
      payload.kind === "agent-turn-completed" &&
      Array.isArray(payload.respondingTo) &&
      payload.respondingTo.includes(eventId)
    );
  });
}

function latestSessionId(room: RoomLedger, agentId: ParticipantId): string | undefined {
  const events = room.readEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.subject.kind === "participant" && event.subject.id === agentId) {
      const payload = event.payload;
      if (
        isRecord(payload) &&
        payload.kind === "presence" &&
        typeof payload.sessionId === "string" &&
        !payload.sessionId.startsWith("pending:")
      ) {
        return payload.sessionId;
      }
    }
  }
  return undefined;
}

function responsePayload(
  text: string,
  respondingTo: readonly EventId[],
  handles: ReadonlyMap<string, ParticipantId>,
  humanId: ParticipantId,
): RoomMessagePayload {
  let team = false;
  const recipients = new Set<ParticipantId>();
  for (const match of text.matchAll(/(^|[^A-Za-z0-9:._-])@([A-Za-z0-9][A-Za-z0-9:._-]*[A-Za-z0-9_-]?)/g)) {
    const rawHandle = match[2];
    if (rawHandle === undefined) {
      continue;
    }
    const normalized = normalizeHandle(rawHandle.replace(/[.:]+$/g, ""));
    if (normalized === "team") {
      team = true;
      break;
    }
    const participant = handles.get(normalized);
    if (participant !== undefined) {
      recipients.add(participant);
    }
  }
  if (!team && recipients.size === 0) {
    recipients.add(humanId);
  }
  return Object.freeze({
    kind: "message",
    text: text.trim(),
    attention: team ? "team" : Object.freeze([...recipients]),
    respondingTo: Object.freeze([...respondingTo]),
  });
}

function turnOutcome(
  stopReason: "completed" | "cancelled" | "refused" | "error",
  replied: boolean,
): AgentTurnCompletedPayload["outcome"] {
  if (replied) {
    return "replied";
  }
  switch (stopReason) {
    case "completed":
      return "empty";
    case "cancelled":
      return "cancelled";
    case "refused":
      return "refused";
    case "error":
      return "error";
  }
}

function traceStatusForStopReason(
  stopReason: "completed" | "cancelled" | "refused" | "error",
): TraceRecord["status"] {
  switch (stopReason) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refused":
    case "error":
      return "failed";
  }
}

function traceStatusForOutcome(
  outcome: AgentTurnCompletedPayload["outcome"],
): TraceRecord["status"] {
  switch (outcome) {
    case "replied":
    case "empty":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refused":
    case "error":
      return "failed";
  }
}

function traceStatusForSessionStatus(
  status: Extract<AgentSessionEvent, { readonly type: "status" }>["status"],
): TraceRecord["status"] {
  switch (status) {
    case "starting":
    case "working":
    case "stopping":
      return "running";
    case "ready":
    case "waiting":
    case "stopped":
      return "completed";
    case "error":
      return "failed";
  }
}

function traceStatusForToolCall(
  status: Extract<AgentSessionEvent, { readonly type: "tool-call" }>["status"],
): TraceRecord["status"] {
  switch (status) {
    case "started":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function turnKey(
  agentId: ParticipantId,
  triggerIds: readonly EventId[],
  observedVersion: number,
): string {
  return `turn:${agentId}:${stableId(triggerIds)}:v${String(observedVersion)}`;
}

function defaultTurnChangeClassifier(
  event: RoomEvent,
  context: TurnChangeContext,
): TurnChangeImpact {
  if (
    event.actorId === context.agentId ||
    !sameSubject(event.subject, context.subject) ||
    event.subjectVersion <= context.basedOnVersion
  ) {
    return "irrelevant";
  }
  return "soft";
}

function normalizeHandle(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9:._-]*$/.test(normalized)) {
    throw new Error(`Invalid participant handle: ${handle}`);
  }
  return normalized;
}

function requireCommitted<T>(result: CommitResult<T>): Committed<T> {
  if (result.status !== "committed") {
    const details =
      result.status === "rejected"
        ? `${result.code}: ${result.message}`
        : `${String(result.conflicts.length)} causal conflict(s)`;
    throw new Error(`Room commit failed: ${details}.`);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
