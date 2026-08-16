import {
  CoreAction,
  type RoomEvent,
  type TraceJournal,
  type TraceRecord,
  type TraceRecordInput,
} from "@ai-mesh/protocol";

import { isMessageEvent, isRecord } from "./event-utils.js";
import { collaborationKey } from "./ids.js";

export class InMemoryTraceJournal implements TraceJournal {
  readonly #records: TraceRecord[] = [];
  readonly #byId = new Map<string, TraceRecord>();

  append(input: TraceRecordInput): TraceRecord {
    const existing = this.#byId.get(input.id);
    if (existing !== undefined) {
      return existing;
    }
    const record = Object.freeze({
      ...structuredClone(input),
      sequence: this.#records.length + 1,
    });
    this.#records.push(record);
    this.#byId.set(record.id, record);
    return record;
  }

  read(): readonly TraceRecord[] {
    return Object.freeze([...this.#records]);
  }
}

export function roomEventTrace(event: RoomEvent): TraceRecordInput {
  const correlationId = roomEventCorrelationId(event);
  return Object.freeze({
    id: `room-event:${event.id}`,
    roomId: event.roomId,
    actorId: event.actorId,
    kind: "room.event.committed",
    status: "committed",
    occurredAt: event.committedAt,
    ...(correlationId === undefined ? {} : { correlationId }),
    detail: event.action,
    data: Object.freeze({
      eventId: event.id,
      roomSequence: event.sequence,
      subject: event.subject,
      subjectVersion: event.subjectVersion,
      action: event.action,
      payload: event.payload,
      causedBy: event.causedBy,
    }),
  });
}

function roomEventCorrelationId(event: RoomEvent): string | undefined {
  if (isMessageEvent(event) && event.payload.respondingTo.length > 0) {
    return collaborationKey(event.payload.respondingTo);
  }
  const payload = event.payload;
  if (
    event.action === CoreAction.agentTurnComplete &&
    isRecord(payload) &&
    Array.isArray(payload.respondingTo) &&
    payload.respondingTo.every((id) => typeof id === "string") &&
    payload.respondingTo.length > 0
  ) {
    return collaborationKey(payload.respondingTo as string[]);
  }
  return undefined;
}
