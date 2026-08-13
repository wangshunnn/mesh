import { createHash, randomUUID } from "node:crypto";

import type {
  AgentAdapter,
  AgentPermissionPolicy,
  AgentSession,
  AgentSessionEvent,
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
  type TaskStatus,
  type TaskUpdatedPayload,
} from "@ai-mesh/protocol";
import type { CommitNotification, RoomLedger, Unsubscribe } from "@ai-mesh/room";
import { ParticipantInbox, type CursorStore, type InboxBatch } from "@ai-mesh/runtime";

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

export interface CollaborationRuntimeOptions {
  readonly room: RoomLedger;
  readonly cursors: CursorStore;
  readonly cwd: string;
  readonly humanId?: ParticipantId;
  readonly humanHandle?: string;
  readonly defaultThreadId?: string;
  readonly maxRebaseAttempts?: number;
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

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly ownerId?: ParticipantId;
  readonly version: number;
  readonly updatedAt: number;
}

export interface RoomSnapshot {
  readonly roomId: string;
  readonly headSequence: number;
  readonly agents: readonly AgentView[];
  readonly messages: readonly MessageView[];
  readonly tasks: readonly TaskView[];
  readonly timeline: readonly RoomEvent[];
}

export type SnapshotListener = (
  snapshot: RoomSnapshot,
  notification: CommitNotification,
) => void;

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
    this.defaultThread = Object.freeze({
      kind: "thread",
      id: options.defaultThreadId ?? "general",
    });
    this.#maxRebaseAttempts = options.maxRebaseAttempts ?? 3;
    if (!Number.isInteger(this.#maxRebaseAttempts) || this.#maxRebaseAttempts < 1) {
      throw new RangeError("maxRebaseAttempts must be a positive integer.");
    }
    this.#handles.set(this.#humanHandle, this.humanId);
    this.#unsubscribeRoom = this.room.subscribe((notification) => {
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
      [...this.#definitions.values()],
      this.#sessionIds,
    );
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
}

class AgentWorker {
  readonly #runtime: CollaborationRuntime;
  readonly #definition: AgentDefinition;
  readonly #inbox: ParticipantInbox;
  readonly #cwd: string;
  readonly #initialSessionId: string | undefined;
  readonly #maxRebaseAttempts: number;
  #session: AgentSession | undefined;
  #unsubscribeWake: Unsubscribe | undefined;
  #work: Promise<void> = Promise.resolve();
  #stopping = false;
  #failed = false;

  constructor(options: AgentWorkerOptions) {
    this.#runtime = options.runtime;
    this.#definition = options.definition;
    this.#cwd = options.cwd;
    this.#initialSessionId = options.sessionId;
    this.#maxRebaseAttempts = options.maxRebaseAttempts;
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
      this.#runtime.commitPresence(this.#definition.id, "error", {
        adapterKind: this.#definition.adapter.kind,
        ...(this.#initialSessionId === undefined ? {} : { sessionId: this.#initialSessionId }),
        detail: errorMessage(error),
      });
      throw error;
    }
    this.#session = session;
    this.#unsubscribeWake = this.#inbox.subscribeToWakeHints(() => this.wake());
    this.#runtime.commitPresence(this.#definition.id, "idle", {
      adapterKind: this.#definition.adapter.kind,
      sessionId: session.id,
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
    this.#unsubscribeWake?.();
    this.#unsubscribeWake = undefined;
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

    try {
      for (let attempt = 1; attempt <= this.#maxRebaseAttempts; attempt += 1) {
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

        let replyEvent: RoomEvent<RoomMessagePayload> | undefined;
        if (result.stopReason === "completed" && result.text.trim().length > 0) {
          const payload = responsePayload(
            result.text,
            triggerIds,
            this.#runtime.participantHandles(),
            this.#runtime.humanId,
          );
          const key = `reply:${turnId}`;
          const commit = this.#runtime.room.commit<RoomMessagePayload>({
            id: key,
            idempotencyKey: key,
            roomId: this.#runtime.room.roomId,
            actorId: this.#definition.id,
            subject: this.#runtime.defaultThread,
            action: CoreAction.threadReplyCommit,
            payload,
            basedOn: [{ subject: this.#runtime.defaultThread, version: observedVersion }],
          });
          if (commit.status === "needs_rebase") {
            continue;
          }
          replyEvent = requireCommitted(commit).event;
        }

        const outcome = turnOutcome(result.stopReason, replyEvent !== undefined);
        this.#commitReceipt(triggerIds, outcome, replyEvent?.id);
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
      this.#runtime.commitPresence(this.#definition.id, "error", {
        adapterKind: this.#definition.adapter.kind,
        sessionId: session.id,
        detail: errorMessage(error),
      });
      throw error;
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

  async #forwardSessionEvents(session: AgentSession): Promise<void> {
    try {
      for await (const event of session.events()) {
        if (this.#stopping) {
          return;
        }
        if (event.type === "error") {
          this.#runtime.commitPresence(this.#definition.id, "error", {
            adapterKind: this.#definition.adapter.kind,
            sessionId: session.id,
            detail: event.message,
          });
        }
      }
    } catch {
      // The worker's prompt/start/stop paths own durable lifecycle reporting.
    }
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

function turnKey(
  agentId: ParticipantId,
  triggerIds: readonly EventId[],
  observedVersion: number,
): string {
  return `turn:${agentId}:${stableId(triggerIds)}:v${String(observedVersion)}`;
}

function stableId(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...values].sort())).digest("hex").slice(0, 24);
}

function freezeAttention(attention: MessageAttention): MessageAttention {
  if (attention === "team") {
    return attention;
  }
  return Object.freeze([...new Set(attention)]);
}

function normalizeHandle(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9:._-]*$/.test(normalized)) {
    throw new Error(`Invalid participant handle: ${handle}`);
  }
  return normalized;
}

function isMessageEvent(event: RoomEvent): event is RoomEvent<RoomMessagePayload> {
  if (
    event.action !== CoreAction.threadMessageAppend &&
    event.action !== CoreAction.threadReplyCommit
  ) {
    return false;
  }
  const payload = event.payload;
  return (
    isRecord(payload) &&
    payload.kind === "message" &&
    typeof payload.text === "string" &&
    (payload.attention === "team" || Array.isArray(payload.attention)) &&
    Array.isArray(payload.respondingTo)
  );
}

function isPresenceEvent(event: RoomEvent): event is RoomEvent<PresencePayload> {
  const payload = event.payload;
  return (
    event.action === CoreAction.participantPresenceSet &&
    isRecord(payload) &&
    payload.kind === "presence" &&
    typeof payload.state === "string"
  );
}

function projectRoom(
  roomId: string,
  events: readonly RoomEvent[],
  definitions: readonly AgentDefinition[],
  sessionIds: ReadonlyMap<ParticipantId, string>,
): RoomSnapshot {
  const messages: MessageView[] = [];
  const presence = new Map<ParticipantId, RoomEvent<PresencePayload>>();
  const tasks = new Map<string, MutableTask>();

  for (const event of events) {
    if (isMessageEvent(event)) {
      messages.push(
        Object.freeze({
          eventId: event.id,
          sequence: event.sequence,
          threadId: event.subject.id,
          from: event.actorId,
          text: event.payload.text,
          attention: freezeAttention(event.payload.attention),
          respondingTo: Object.freeze([...event.payload.respondingTo]),
          createdAt: event.committedAt,
        }),
      );
    } else if (isPresenceEvent(event)) {
      presence.set(event.subject.id, event);
    } else if (event.subject.kind === "task") {
      projectTaskEvent(tasks, event);
    }
  }

  const agents = definitions.map((definition): AgentView => {
    const latest = presence.get(definition.id);
    const payload = latest?.payload;
    const sessionId = payload?.sessionId ?? sessionIds.get(definition.id) ?? definition.sessionId;
    return Object.freeze({
      id: definition.id,
      name: definition.name,
      handle: definition.handle,
      adapterKind: definition.adapter.kind,
      state: payload?.state ?? "offline",
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(payload?.detail === undefined ? {} : { detail: payload.detail }),
      ...(latest === undefined ? {} : { updatedAt: latest.committedAt }),
    });
  });

  return Object.freeze({
    roomId,
    headSequence: events.at(-1)?.sequence ?? 0,
    agents: Object.freeze(agents),
    messages: Object.freeze(messages),
    tasks: Object.freeze([...tasks.values()].map(freezeTask)),
    timeline: Object.freeze([...events]),
  });
}

interface MutableTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  ownerId?: ParticipantId;
  version: number;
  updatedAt: number;
}

function projectTaskEvent(tasks: Map<string, MutableTask>, event: RoomEvent): void {
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.kind !== "string") {
    return;
  }
  if (payload.kind === "task-created" && typeof payload.title === "string") {
    tasks.set(event.subject.id, {
      id: event.subject.id,
      title: payload.title,
      ...(typeof payload.description === "string" ? { description: payload.description } : {}),
      status: "todo",
      version: event.subjectVersion,
      updatedAt: event.committedAt,
    });
    return;
  }
  const task = tasks.get(event.subject.id);
  if (task === undefined) {
    return;
  }
  if (payload.kind === "task-claimed" && typeof payload.ownerId === "string") {
    task.ownerId = payload.ownerId;
    task.status = "in_progress";
  } else if (payload.kind === "task-updated" && isTaskStatus(payload.status)) {
    task.status = payload.status;
  } else {
    return;
  }
  task.version = event.subjectVersion;
  task.updatedAt = event.committedAt;
}

function freezeTask(task: MutableTask): TaskView {
  return Object.freeze({
    id: task.id,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    status: task.status,
    ...(task.ownerId === undefined ? {} : { ownerId: task.ownerId }),
    version: task.version,
    updatedAt: task.updatedAt,
  });
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "todo" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "review" ||
    value === "done"
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
