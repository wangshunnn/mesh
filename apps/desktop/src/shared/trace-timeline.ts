import type { TraceRecord } from "@ai-mesh/protocol";
import type { RoomSnapshot } from "@ai-mesh/workspace";

type MessageView = RoomSnapshot["messages"][number];

export type TraceTimelineEdgeKind = "trigger" | "change" | "commit" | "reply";

export interface TraceTimelineRoomNode {
  readonly id: string;
  readonly sequence: number;
  readonly actorId: string;
  readonly text: string;
  readonly respondingTo: readonly string[];
  readonly occurredAt: number;
  readonly sourceTurnIds: readonly string[];
  readonly traceMissing: boolean;
}

export interface TraceTimelineTurn {
  readonly id: string;
  readonly actorId: string;
  readonly correlationId?: string;
  readonly attempt: number;
  readonly records: readonly TraceRecord[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: TraceRecord["status"];
  readonly triggerIds: readonly string[];
  readonly changeEventIds: readonly string[];
  readonly replyEventIds: readonly string[];
  readonly phases: readonly TraceTimelineTurnPhase[];
  readonly overlapsPrevious: boolean;
}

export type TraceTimelineTurnPhaseKind =
  | "generation"
  | "validation"
  | "reconciliation"
  | "committed"
  | "finishing"
  | "expired"
  | "failed";

export interface TraceTimelineTurnPhase {
  readonly id: string;
  readonly kind: TraceTimelineTurnPhaseKind;
  readonly label: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface TraceTimelineAgentLane {
  readonly actorId: string;
  readonly turns: readonly TraceTimelineTurn[];
  readonly standaloneRecords: readonly TraceRecord[];
}

export interface TraceTimelineEndpoint {
  readonly kind: "room" | "turn";
  readonly id: string;
  readonly occurredAt: number;
}

export interface TraceTimelineEdge {
  readonly id: string;
  readonly kind: TraceTimelineEdgeKind;
  readonly source: TraceTimelineEndpoint;
  readonly target: TraceTimelineEndpoint;
}

export interface TraceTimelineIssue {
  readonly id: string;
  readonly kind: "missing-turn" | "missing-room-reply" | "agent-overlap";
  readonly actorId?: string;
  readonly messageId?: string;
  readonly turnId?: string;
  readonly detail: string;
}

export interface TraceTimelineProjection {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly room: readonly TraceTimelineRoomNode[];
  readonly lanes: readonly TraceTimelineAgentLane[];
  readonly turns: readonly TraceTimelineTurn[];
  readonly edges: readonly TraceTimelineEdge[];
  readonly issues: readonly TraceTimelineIssue[];
}

export function buildTraceTimeline(snapshot: RoomSnapshot): TraceTimelineProjection {
  const records = snapshot.trace
    .slice()
    .sort((left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence);
  const messages = snapshot.messages.slice().sort((left, right) => left.sequence - right.sequence);
  const messageById = new Map(messages.map((message) => [message.eventId, message]));
  const messageBySequence = new Map(messages.map((message) => [message.sequence, message]));
  const turnRecords = new Map<string, TraceRecord[]>();
  const standaloneByActor = new Map<string, TraceRecord[]>();

  for (const record of records) {
    if (record.turnId !== undefined && record.kind.startsWith("agent.")) {
      const grouped = turnRecords.get(record.turnId) ?? [];
      grouped.push(record);
      turnRecords.set(record.turnId, grouped);
    } else if (record.kind.startsWith("agent.")) {
      const standalone = standaloneByActor.get(record.actorId) ?? [];
      standalone.push(record);
      standaloneByActor.set(record.actorId, standalone);
    }
  }

  const provisionalTurns = [...turnRecords.entries()].map(([id, grouped]) =>
    createTurn(id, grouped, messageBySequence),
  );
  const actorIds = traceAgentIds(snapshot, records, provisionalTurns);
  const lanes = [...actorIds].map((actorId) => {
    const actorTurns = provisionalTurns
      .filter((turn) => turn.actorId === actorId)
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
    const turns = actorTurns.map((turn, index) => Object.freeze({
      ...turn,
      overlapsPrevious: index > 0 && turn.startedAt < (actorTurns[index - 1]?.endedAt ?? 0),
    }));
    return Object.freeze({
      actorId,
      turns: Object.freeze(turns),
      standaloneRecords: Object.freeze(
        (standaloneByActor.get(actorId) ?? []).slice().sort(compareTraceRecords),
      ),
    });
  });
  const turns = lanes.flatMap((lane) => lane.turns);
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const sourceTurnsByReply = new Map<string, string[]>();
  for (const turn of turns) {
    for (const replyEventId of turn.replyEventIds) {
      const sources = sourceTurnsByReply.get(replyEventId) ?? [];
      sources.push(turn.id);
      sourceTurnsByReply.set(replyEventId, sources);
    }
  }

  const room = messages.map((message) => {
    const sourceTurnIds = sourceTurnsByReply.get(message.eventId) ?? [];
    return Object.freeze({
      id: message.eventId,
      sequence: message.sequence,
      actorId: message.from,
      text: message.text,
      respondingTo: Object.freeze([...message.respondingTo]),
      occurredAt: message.createdAt,
      sourceTurnIds: Object.freeze([...sourceTurnIds]),
      traceMissing: message.from !== "human" && sourceTurnIds.length === 0,
    });
  });

  const edges = buildEdges(room, turns, messageById, turnById);
  const issues = buildIssues(room, turns, messageById);
  const timestamps = [
    ...room.map((message) => message.occurredAt),
    ...turns.flatMap((turn) => [turn.startedAt, turn.endedAt]),
    ...records.map((record) => record.occurredAt),
  ];
  const now = Date.now();
  const startedAt = timestamps.length === 0 ? now : Math.min(...timestamps);
  const endedAt = timestamps.length === 0 ? now : Math.max(...timestamps);

  return Object.freeze({
    startedAt,
    endedAt: Math.max(startedAt + 1, endedAt),
    room: Object.freeze(room),
    lanes: Object.freeze(lanes),
    turns: Object.freeze(turns),
    edges: Object.freeze(edges),
    issues: Object.freeze(issues),
  });
}

function createTurn(
  id: string,
  records: readonly TraceRecord[],
  messageBySequence: ReadonlyMap<number, MessageView>,
): Omit<TraceTimelineTurn, "overlapsPrevious"> {
  const ordered = records.slice().sort(compareTraceRecords);
  const triggerIds = new Set<string>();
  const changeEventIds = new Set<string>();
  const replyEventIds = new Set<string>();

  for (const record of ordered) {
    for (const triggerId of stringArray(record.data?.triggerIds)) {
      triggerIds.add(triggerId);
    }
    const changeEventId = record.data?.changeEventId;
    if (typeof changeEventId === "string") {
      changeEventIds.add(changeEventId);
    }
    for (const id of stringArray(record.data?.changeEventIds)) {
      changeEventIds.add(id);
    }
    const replyEventId = record.data?.replyEventId;
    if (typeof replyEventId === "string") {
      replyEventIds.add(replyEventId);
    }
    if (
      record.kind === "agent.draft.committed" &&
      typeof record.data?.roomSequence === "number"
    ) {
      const message = messageBySequence.get(record.data.roomSequence);
      if (message !== undefined && message.from === record.actorId) {
        replyEventIds.add(message.eventId);
      }
    }
  }

  const first = ordered.find((record) => record.kind === "agent.turn.started") ?? ordered[0];
  // A turn's duration describes the Agent state machine only. The linked Room
  // commit can be persisted later and remains a separate point on the Room rail.
  const endedAt = ordered.at(-1)?.occurredAt ?? first?.occurredAt ?? 0;
  const startedAt = first?.occurredAt ?? endedAt;

  return Object.freeze({
    id,
    actorId: first?.actorId ?? "unknown",
    ...(first?.correlationId === undefined ? {} : { correlationId: first.correlationId }),
    attempt: ordered.find((record) => record.attempt !== undefined)?.attempt ?? 1,
    records: Object.freeze(ordered),
    startedAt,
    endedAt,
    status: turnStatus(ordered, replyEventIds.size > 0),
    triggerIds: Object.freeze([...triggerIds]),
    changeEventIds: Object.freeze([...changeEventIds]),
    replyEventIds: Object.freeze([...replyEventIds]),
    phases: buildTurnPhases(id, ordered, startedAt, endedAt),
  });
}

function buildTurnPhases(
  turnId: string,
  records: readonly TraceRecord[],
  startedAt: number,
  endedAt: number,
): readonly TraceTimelineTurnPhase[] {
  let kind: TraceTimelineTurnPhaseKind = "generation";
  let phaseStartedAt = startedAt;
  let sequence = 0;
  const phases: TraceTimelineTurnPhase[] = [];
  const transition = (next: TraceTimelineTurnPhaseKind, occurredAt: number): void => {
    const boundary = Math.min(endedAt, Math.max(phaseStartedAt, occurredAt));
    if (boundary > phaseStartedAt) {
      phases.push(Object.freeze({
        id: `${turnId}:phase:${String(sequence)}`,
        kind,
        label: turnPhaseLabel(kind),
        startedAt: phaseStartedAt,
        endedAt: boundary,
      }));
      sequence += 1;
    }
    kind = next;
    phaseStartedAt = boundary;
  };

  for (const record of records) {
    switch (record.kind) {
      case "agent.draft.generated":
        transition("validation", record.occurredAt);
        break;
      case "agent.turn.result":
        transition("finishing", record.occurredAt);
        break;
      case "agent.reconciliation.started":
        transition("reconciliation", record.occurredAt);
        break;
      case "agent.reconciliation.decided":
        transition(
          record.status === "expired" || record.status === "cancelled"
            ? "finishing"
            : "validation",
          record.occurredAt,
        );
        break;
      case "agent.draft.committed":
        transition("committed", record.occurredAt);
        break;
      case "agent.draft.expired":
        transition("expired", record.occurredAt);
        break;
      case "agent.turn.failed":
        transition("failed", record.occurredAt);
        break;
      default:
        break;
    }
  }
  transition(kind, endedAt);
  return Object.freeze(phases);
}

function turnPhaseLabel(kind: TraceTimelineTurnPhaseKind): string {
  return ({
    generation: "生成",
    validation: "候选校验",
    reconciliation: "调和",
    committed: "已提交",
    finishing: "收尾",
    expired: "已过期",
    failed: "失败",
  } as const)[kind];
}

function buildEdges(
  room: readonly TraceTimelineRoomNode[],
  turns: readonly TraceTimelineTurn[],
  messageById: ReadonlyMap<string, MessageView>,
  turnById: ReadonlyMap<string, TraceTimelineTurn>,
): TraceTimelineEdge[] {
  const edges: TraceTimelineEdge[] = [];
  const seen = new Set<string>();
  const append = (edge: TraceTimelineEdge): void => {
    if (!seen.has(edge.id)) {
      seen.add(edge.id);
      edges.push(Object.freeze(edge));
    }
  };

  for (const message of room) {
    for (const parentId of message.respondingTo) {
      const parent = messageById.get(parentId);
      if (parent === undefined) continue;
      append({
        id: `reply:${parentId}:${message.id}`,
        kind: "reply",
        source: { kind: "room", id: parentId, occurredAt: parent.createdAt },
        target: { kind: "room", id: message.id, occurredAt: message.occurredAt },
      });
    }
  }

  for (const turn of turns) {
    for (const triggerId of turn.triggerIds) {
      const message = messageById.get(triggerId);
      if (message === undefined) continue;
      append({
        id: `trigger:${triggerId}:${turn.id}`,
        kind: "trigger",
        source: { kind: "room", id: triggerId, occurredAt: message.createdAt },
        target: { kind: "turn", id: turn.id, occurredAt: turn.startedAt },
      });
    }
    for (const changeEventId of turn.changeEventIds) {
      const message = messageById.get(changeEventId);
      if (message === undefined) continue;
      append({
        id: `change:${changeEventId}:${turn.id}`,
        kind: "change",
        source: { kind: "room", id: changeEventId, occurredAt: message.createdAt },
        target: {
          kind: "turn",
          id: turn.id,
          occurredAt: changeTargetAt(turn, changeEventId),
        },
      });
    }
    for (const replyEventId of turn.replyEventIds) {
      const message = messageById.get(replyEventId);
      if (message === undefined) continue;
      append({
        id: `commit:${turn.id}:${replyEventId}`,
        kind: "commit",
        source: {
          kind: "turn",
          id: turn.id,
          occurredAt: commitSourceAt(turn, replyEventId),
        },
        target: { kind: "room", id: replyEventId, occurredAt: message.createdAt },
      });
    }
  }

  return edges.filter(
    (edge) =>
      edge.source.kind === "room" || turnById.has(edge.source.id),
  );
}

function buildIssues(
  room: readonly TraceTimelineRoomNode[],
  turns: readonly TraceTimelineTurn[],
  messageById: ReadonlyMap<string, MessageView>,
): TraceTimelineIssue[] {
  const issues: TraceTimelineIssue[] = [];
  for (const message of room) {
    if (!message.traceMissing) continue;
    issues.push(Object.freeze({
      id: `missing-turn:${message.id}`,
      kind: "missing-turn",
      actorId: message.actorId,
      messageId: message.id,
      detail: `Room 消息 #${String(message.sequence)} 没有可关联的 Agent turn。`,
    }));
  }
  for (const turn of turns) {
    for (const replyEventId of turn.replyEventIds) {
      if (messageById.has(replyEventId)) continue;
      issues.push(Object.freeze({
        id: `missing-room-reply:${turn.id}:${replyEventId}`,
        kind: "missing-room-reply",
        actorId: turn.actorId,
        turnId: turn.id,
        detail: `Agent turn 声明提交 ${replyEventId}，但 Room 消息不存在。`,
      }));
    }
    if (turn.overlapsPrevious) {
      issues.push(Object.freeze({
        id: `agent-overlap:${turn.id}`,
        kind: "agent-overlap",
        actorId: turn.actorId,
        turnId: turn.id,
        detail: "同一个 Agent 的两次 turn 在时间上发生重叠。",
      }));
    }
  }
  return issues;
}

function traceAgentIds(
  snapshot: RoomSnapshot,
  records: readonly TraceRecord[],
  turns: readonly Omit<TraceTimelineTurn, "overlapsPrevious">[],
): ReadonlySet<string> {
  const ids = new Set(snapshot.agents.map((agent) => agent.id));
  for (const turn of turns) ids.add(turn.actorId);
  for (const record of records) {
    if (record.kind.startsWith("agent.")) ids.add(record.actorId);
  }
  for (const message of snapshot.messages) {
    if (message.from !== "human") ids.add(message.from);
  }
  return ids;
}

function changeTargetAt(turn: TraceTimelineTurn, eventId: string): number {
  const matching = turn.records.filter(
    (record) =>
      record.data?.changeEventId === eventId ||
      stringArray(record.data?.changeEventIds).includes(eventId),
  );
  return matching[0]?.occurredAt ?? turn.endedAt;
}

function commitSourceAt(turn: TraceTimelineTurn, replyEventId: string): number {
  const matching = turn.records.filter(
    (record) => record.data?.replyEventId === replyEventId,
  );
  return matching.at(-1)?.occurredAt ?? turn.endedAt;
}

function turnStatus(
  records: readonly TraceRecord[],
  hasCommittedReply: boolean,
): TraceRecord["status"] {
  if (records.some((record) => record.kind === "agent.turn.failed" || record.status === "failed")) {
    return "failed";
  }
  if (hasCommittedReply || records.some((record) => record.kind === "agent.draft.committed")) {
    return "committed";
  }
  const latest = records.at(-1);
  if (latest?.kind === "agent.turn.completed") return latest.status;
  if (records.some((record) => record.status === "expired")) return "expired";
  if (records.some((record) => record.status === "dirty")) return "dirty";
  if (records.some((record) => record.status === "pending")) return "pending";
  if (records.some((record) => record.status === "running")) return "running";
  return latest?.status ?? "info";
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : Object.freeze([]);
}

function compareTraceRecords(left: TraceRecord, right: TraceRecord): number {
  return left.occurredAt - right.occurredAt || left.sequence - right.sequence;
}
