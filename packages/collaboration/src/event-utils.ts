import {
  CoreAction,
  type MessageAttention,
  type RoomEvent,
  type RoomMessagePayload,
} from "@ai-mesh/protocol";

export function freezeAttention(attention: MessageAttention): MessageAttention {
  if (attention === "team") {
    return attention;
  }
  return Object.freeze([...new Set(attention)]);
}

export function isMessageEvent(event: RoomEvent): event is RoomEvent<RoomMessagePayload> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
