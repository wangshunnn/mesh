import type {
  AgentView,
  MessageView,
  RoomSnapshot,
  TaskView,
} from "@ai-mesh/application";
import {
  CoreAction,
  type ParticipantId,
  type PresencePayload,
  type RoomEvent,
  type TaskStatus,
  type TraceRecord,
} from "@ai-mesh/protocol";

import { freezeAttention, isMessageEvent, isRecord } from "./event-utils.js";

export interface RoomAgentProjectionDefinition {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapterKind: string;
  readonly sessionId?: string;
}

export function projectRoom(
  roomId: string,
  events: readonly RoomEvent[],
  definitions: readonly RoomAgentProjectionDefinition[],
  sessionIds: ReadonlyMap<ParticipantId, string>,
  trace: readonly TraceRecord[],
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
      adapterKind: definition.adapterKind,
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
    trace: Object.freeze([...trace]),
  });
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
