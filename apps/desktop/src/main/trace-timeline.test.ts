import assert from "node:assert/strict";
import test from "node:test";

import type { TraceRecord } from "@ai-mesh/protocol";
import type { RoomSnapshot } from "@ai-mesh/workspace";

import { buildTraceTimeline } from "../shared/trace-timeline.js";

test("Room messages stay serial while Agent turns remain independent concurrent lanes", () => {
  const projection = buildTraceTimeline(fixtureSnapshot());

  assert.deepEqual(projection.room.map((message) => message.sequence), [27, 31, 33, 36, 40]);
  assert.deepEqual(projection.lanes.map((lane) => lane.actorId), [
    "agent:opencode",
    "agent:codex",
  ]);
  assert.equal(projection.lanes[0]?.turns.length, 1);
  assert.equal(projection.lanes[1]?.turns.length, 2);
  assert.equal(
    (projection.lanes[1]?.turns[0]?.startedAt ?? Number.POSITIVE_INFINITY) <
      (projection.lanes[0]?.turns[0]?.endedAt ?? Number.NEGATIVE_INFINITY),
    true,
  );
});

test("trigger, reconciliation, and commit edges use explicit protocol references", () => {
  const projection = buildTraceTimeline(fixtureSnapshot());
  const codexOldTurn = projection.turns.find((turn) => turn.id === "turn:codex:old");
  const reply36 = projection.room.find((message) => message.sequence === 36);

  assert.deepEqual(codexOldTurn?.triggerIds, ["message:27"]);
  assert.deepEqual(codexOldTurn?.changeEventIds, ["message:31", "message:33"]);
  assert.deepEqual(codexOldTurn?.replyEventIds, ["message:36"]);
  assert.equal(codexOldTurn?.endedAt, 1_700_000_045_000);
  assert.deepEqual(reply36?.sourceTurnIds, ["turn:codex:old"]);
  assert.deepEqual(
    projection.edges
      .filter((edge) => edge.target.id === "turn:codex:old" || edge.source.id === "turn:codex:old")
      .map((edge) => edge.kind),
    ["trigger", "change", "change", "commit"],
  );
});

test("an Agent Room reply without a turn remains visible and becomes a diagnostic issue", () => {
  const fixture = fixtureSnapshot();
  const snapshot: RoomSnapshot = Object.freeze({
    ...fixture,
    messages: Object.freeze([
      ...fixture.messages,
      message(44, "agent:opencode", "没有 turn 轨迹的提交", ["message:40"]),
    ]),
  });

  const projection = buildTraceTimeline(snapshot);
  const reply44 = projection.room.find((roomMessage) => roomMessage.sequence === 44);

  assert.equal(reply44?.traceMissing, true);
  assert.equal(projection.issues.some((issue) => issue.messageId === "message:44"), true);
});

test("turn phases come only from explicit state-machine boundaries", () => {
  const startedAt = 1_700_100_000_000;
  const snapshot: RoomSnapshot = Object.freeze({
    roomId: "room:phases",
    headSequence: 0,
    agents: Object.freeze([agent("agent:codex", "Codex", "codex")]),
    messages: Object.freeze([]),
    tasks: Object.freeze([]),
    timeline: Object.freeze([]),
    trace: Object.freeze([
      trace(1, "agent:codex", "agent.turn.started", startedAt, {
        turnId: "turn:phases",
        status: "running",
      }),
      trace(2, "agent:codex", "agent.tool.completed", startedAt + 2_000, {
        turnId: "turn:phases",
        status: "completed",
      }),
      trace(3, "agent:codex", "agent.draft.generated", startedAt + 6_000, {
        turnId: "turn:phases",
        status: "pending",
      }),
      trace(4, "agent:codex", "agent.reconciliation.started", startedAt + 6_500, {
        turnId: "turn:phases",
        status: "running",
      }),
      trace(5, "agent:codex", "agent.reconciliation.decided", startedAt + 8_500, {
        turnId: "turn:phases",
        status: "completed",
      }),
      trace(6, "agent:codex", "agent.draft.committed", startedAt + 9_000, {
        turnId: "turn:phases",
        status: "committed",
      }),
      trace(7, "agent:codex", "agent.turn.completed", startedAt + 9_200, {
        turnId: "turn:phases",
        status: "completed",
      }),
    ]),
  });
  const turn = buildTraceTimeline(snapshot).turns[0];

  assert.deepEqual(turn?.phases.map((phase) => ({
    kind: phase.kind,
    startedAt: phase.startedAt - startedAt,
    endedAt: phase.endedAt - startedAt,
  })), [
    { kind: "generation", startedAt: 0, endedAt: 6_000 },
    { kind: "validation", startedAt: 6_000, endedAt: 6_500 },
    { kind: "reconciliation", startedAt: 6_500, endedAt: 8_500 },
    { kind: "validation", startedAt: 8_500, endedAt: 9_000 },
    { kind: "committed", startedAt: 9_000, endedAt: 9_200 },
  ]);
});

function fixtureSnapshot(): RoomSnapshot {
  const startedAt = 1_700_000_000_000;
  return Object.freeze({
    roomId: "room:test",
    headSequence: 40,
    agents: Object.freeze([
      agent("agent:opencode", "OpenCode", "opencode"),
      agent("agent:codex", "Codex", "codex"),
    ]),
    messages: Object.freeze([
      message(27, "agent:opencode", "旧消息", [], startedAt),
      message(31, "human", "一人报个数", [], startedAt + 20_000),
      message(33, "agent:opencode", "@codex 你来一个？", ["message:31"], startedAt + 22_000),
      // Room persistence may lag behind the Agent state machine; it must not
      // inflate the Agent turn duration shown in the trajectory.
      message(36, "agent:codex", "@human 我报 42 ✨", ["message:27"], startedAt + 55_000),
      message(40, "agent:codex", "@opencode 我选 42，交卷", ["message:33"], startedAt + 63_000),
    ]),
    tasks: Object.freeze([]),
    timeline: Object.freeze([]),
    trace: Object.freeze([
      trace(1, "agent:codex", "agent.turn.started", startedAt + 1_000, {
        turnId: "turn:codex:old",
        correlationId: "correlation:old",
        status: "running",
        data: { triggerIds: ["message:27"] },
      }),
      trace(2, "agent:opencode", "agent.turn.started", startedAt + 20_100, {
        turnId: "turn:opencode:count",
        correlationId: "correlation:count",
        status: "running",
        data: { triggerIds: ["message:31"] },
      }),
      trace(3, "agent:opencode", "agent.draft.committed", startedAt + 22_000, {
        turnId: "turn:opencode:count",
        correlationId: "correlation:count",
        data: { replyEventId: "message:33", roomSequence: 33 },
      }),
      trace(4, "agent:codex", "agent.turn.dirty", startedAt + 22_001, {
        turnId: "turn:codex:old",
        correlationId: "correlation:old",
        status: "dirty",
        data: { changeEventId: "message:31" },
      }),
      trace(5, "agent:codex", "agent.reconciliation.started", startedAt + 42_000, {
        turnId: "turn:codex:old",
        correlationId: "correlation:old",
        status: "running",
        data: { changeEventIds: ["message:31", "message:33"] },
      }),
      trace(6, "agent:codex", "agent.draft.committed", startedAt + 45_000, {
        turnId: "turn:codex:old",
        correlationId: "correlation:old",
        data: { replyEventId: "message:36", roomSequence: 36 },
      }),
      trace(7, "agent:codex", "agent.turn.started", startedAt + 45_100, {
        turnId: "turn:codex:new",
        correlationId: "correlation:new",
        status: "running",
        data: { triggerIds: ["message:33"] },
      }),
      trace(8, "agent:codex", "agent.draft.committed", startedAt + 63_000, {
        turnId: "turn:codex:new",
        correlationId: "correlation:new",
        data: { replyEventId: "message:40", roomSequence: 40 },
      }),
    ]),
  });
}

function agent(id: string, name: string, handle: string): RoomSnapshot["agents"][number] {
  return Object.freeze({ id, name, handle, adapterKind: handle, state: "waiting" });
}

function message(
  sequence: number,
  from: string,
  text: string,
  respondingTo: readonly string[],
  createdAt = 1_700_000_000_000 + sequence * 1_000,
): RoomSnapshot["messages"][number] {
  return Object.freeze({
    eventId: `message:${String(sequence)}`,
    sequence,
    threadId: "general",
    from,
    text,
    attention: Object.freeze([]),
    respondingTo: Object.freeze([...respondingTo]),
    createdAt,
  });
}

function trace(
  sequence: number,
  actorId: string,
  kind: string,
  occurredAt: number,
  overrides: Partial<TraceRecord>,
): TraceRecord {
  return Object.freeze({
    id: `trace:${String(sequence)}`,
    sequence,
    roomId: "room:test",
    actorId,
    kind,
    status: "committed",
    occurredAt,
    ...overrides,
  });
}
