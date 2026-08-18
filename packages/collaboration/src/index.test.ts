import assert from "node:assert/strict";
import test from "node:test";

import { ScriptedAgentAdapter, type AgentAdapter } from "@ai-mesh/agent";
import { CoreAction, type RoomMessagePayload } from "@ai-mesh/protocol";
import { InMemoryRoomLedger } from "@ai-mesh/room";
import { InMemoryCursorStore } from "@ai-mesh/runtime";

import { CollaborationRuntime } from "./index.js";

function runtimeWithTwoAgents(): {
  readonly runtime: CollaborationRuntime;
  readonly room: InMemoryRoomLedger;
  readonly turns: Map<string, number>;
} {
  const room = new InMemoryRoomLedger("room:vertical");
  const turns = new Map<string, number>();
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  runtime.registerAgent({
    id: "agent:a",
    name: "Agent A",
    handle: "a",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("script-a", ({ agentId }) => {
      turns.set(agentId, (turns.get(agentId) ?? 0) + 1);
      return "A analyzed the request. @b please verify the dependency.";
    }),
  });
  runtime.registerAgent({
    id: "agent:b",
    name: "Agent B",
    handle: "b",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("script-b", ({ agentId }) => {
      turns.set(agentId, (turns.get(agentId) ?? 0) + 1);
      return "B verified it. @human the collaboration loop is complete.";
    }),
  });
  return { runtime, room, turns };
}

test("Human -> A -> B -> Human closes through independent room subscriptions", async () => {
  const { runtime, room, turns } = runtimeWithTwoAgents();
  await runtime.startAgent("agent:a");
  await runtime.startAgent("agent:b");

  const command = runtime.postMessage({
    text: "@a analyze auth",
    attention: ["agent:a"],
    idempotencyKey: "human:command",
  });
  await runtime.settle();

  const messages = runtime.snapshot().messages;
  assert.deepEqual(messages.map((message) => message.from), ["human", "agent:a", "agent:b"]);
  assert.deepEqual(messages[0]?.attention, ["agent:a"]);
  assert.deepEqual(messages[1]?.attention, ["agent:b"]);
  assert.deepEqual(messages[2]?.attention, ["human"]);
  assert.deepEqual(messages[1]?.respondingTo, [command.id]);
  assert.deepEqual(turns, new Map([["agent:a", 1], ["agent:b", 1]]));

  const receipts = room
    .readEvents()
    .filter((event) => event.action === CoreAction.agentTurnComplete);
  assert.equal(receipts.length, 2);
  await runtime.close();
});

test("an unordered team count converges from live room state without duplicate numbers", async () => {
  const room = new InMemoryRoomLedger("room:counting");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  const counter = ({ prompt }: { readonly prompt: { readonly text: string } }): string => {
    const counts = [...prompt.text.matchAll(/"text":"报数 (\d+)/g)].map((match) =>
      Number.parseInt(match[1] ?? "0", 10),
    );
    return `报数 ${String(Math.max(0, ...counts) + 1)} @human`;
  };
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: true,
    adapter: new ScriptedAgentAdapter("a", counter),
  });
  runtime.registerAgent({
    id: "agent:b",
    name: "B",
    handle: "b",
    respondToTeam: true,
    adapter: new ScriptedAgentAdapter("b", counter),
  });
  await runtime.startAgent("agent:a");
  await runtime.startAgent("agent:b");

  runtime.postMessage({ text: "报数！", attention: "team", idempotencyKey: "count:start" });
  await runtime.settle();

  const replies = runtime.snapshot().messages.slice(1);
  assert.equal(replies.length, 2);
  assert.deepEqual(new Set(replies.map((message) => message.from)), new Set(["agent:a", "agent:b"]));
  assert.deepEqual(
    replies
      .map((message) => Number.parseInt(message.text.match(/报数 (\d+)/)?.[1] ?? "0", 10))
      .sort(),
    [1, 2],
  );
  assert.ok(replies.some((message) => message.sequence > 1 && message.text === "报数 2 @human"));
  await runtime.close();
});

test("a concurrent count patches the stale candidate without repeating the full turn", async () => {
  const room = new InMemoryRoomLedger("room:counting-reconciliation");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let arrivals = 0;
  let releaseInitial: (() => void) | undefined;
  const bothInitialPromptsStarted = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const turns = new Map<string, number>();
  const counter = async ({
    agentId,
    prompt,
  }: {
    readonly agentId: string;
    readonly prompt: { readonly text: string };
  }): Promise<string> => {
    turns.set(agentId, (turns.get(agentId) ?? 0) + 1);
    if (prompt.text.startsWith("MESH INTERNAL RECONCILIATION")) {
      return JSON.stringify({
        decision: "patch",
        text: "报数 2 @human",
        reason: "Another participant already committed 1.",
      });
    }
    arrivals += 1;
    if (arrivals === 2) {
      releaseInitial?.();
    }
    await bothInitialPromptsStarted;
    return "报数 1 @human";
  };
  for (const id of ["a", "b"] as const) {
    runtime.registerAgent({
      id: `agent:${id}`,
      name: id.toUpperCase(),
      handle: id,
      respondToTeam: true,
      adapter: new ScriptedAgentAdapter(id, counter),
    });
    await runtime.startAgent(`agent:${id}`);
  }

  runtime.postMessage({ text: "报数！", attention: "team", idempotencyKey: "count:reconcile" });
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.deepEqual(
    snapshot.messages.slice(1).map((message) => message.text).sort(),
    ["报数 1 @human", "报数 2 @human"],
  );
  assert.equal(snapshot.trace.filter((record) => record.kind === "agent.turn.started").length, 2);
  assert.equal(snapshot.trace.filter((record) => record.kind === "agent.draft.expired").length, 0);
  const patched = snapshot.trace.filter(
    (record) =>
      record.kind === "agent.reconciliation.decided" && record.data?.decision === "patch",
  );
  assert.equal(patched.length, 1);
  assert.equal(patched[0]?.content, "报数 2 @human");
  assert.deepEqual([...turns.values()].sort(), [1, 2]);
  await runtime.close();
});

test("multiple soft thread changes coalesce into one keep review without a full retry", async () => {
  const room = new InMemoryRoomLedger("room:reconciliation-keep");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let promptCount = 0;
  let releaseInitial: (() => void) | undefined;
  let reportInitialStarted: (() => void) | undefined;
  const initialStarted = new Promise<void>((resolve) => {
    reportInitialStarted = resolve;
  });
  const holdInitial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: true,
    adapter: new ScriptedAgentAdapter("a", async ({ prompt }) => {
      promptCount += 1;
      if (prompt.text.startsWith("MESH INTERNAL RECONCILIATION")) {
        return JSON.stringify({
          decision: "keep",
          reason: "The added context does not affect the answer.",
        });
      }
      reportInitialStarted?.();
      await holdInitial;
      return "@human 原候选仍然成立";
    }),
  });
  await runtime.startAgent("agent:a");
  runtime.postMessage({ text: "给出结论", attention: "team", idempotencyKey: "keep:start" });
  await initialStarted;
  for (let index = 1; index <= 3; index += 1) {
    runtime.postMessage({
      text: `补充第 ${String(index)} 条无冲突背景`,
      attention: ["human"],
      idempotencyKey: `keep:background:${String(index)}`,
    });
  }
  releaseInitial?.();
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.equal(promptCount, 2);
  assert.equal(snapshot.messages.at(-1)?.text, "@human 原候选仍然成立");
  assert.equal(snapshot.trace.filter((record) => record.kind === "agent.turn.started").length, 1);
  assert.equal(snapshot.trace.filter((record) => record.kind === "agent.turn.dirty").length, 3);
  assert.equal(
    snapshot.trace.filter((record) => record.kind === "agent.reconciliation.started").length,
    1,
  );
  assert.equal(
    snapshot.trace.some(
      (record) =>
        record.kind === "agent.reconciliation.decided" && record.data?.decision === "keep",
    ),
    true,
  );
  assert.equal(snapshot.trace.some((record) => record.kind === "agent.draft.expired"), false);
  await runtime.close();
});

test("a hot Room delta skips reconciliation and falls back to one full retry", async () => {
  const room = new InMemoryRoomLedger("room:reconciliation-overflow");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
    maxReconciliationDeltaEvents: 2,
    reconciliationQuietWindowMs: 0,
  });
  let fullPromptCount = 0;
  let reconciliationPromptCount = 0;
  let releaseInitial: (() => void) | undefined;
  let reportInitialStarted: (() => void) | undefined;
  const initialStarted = new Promise<void>((resolve) => {
    reportInitialStarted = resolve;
  });
  const holdInitial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: true,
    adapter: new ScriptedAgentAdapter("a", async ({ prompt }) => {
      if (prompt.text.startsWith("MESH INTERNAL RECONCILIATION")) {
        reconciliationPromptCount += 1;
        return JSON.stringify({ decision: "keep" });
      }
      fullPromptCount += 1;
      if (fullPromptCount === 1) {
        reportInitialStarted?.();
        await holdInitial;
        return "@human 过期候选";
      }
      assert.match(prompt.text, /room changed during your previous reasoning/);
      return "@human 基于最新状态完整重算";
    }),
  });
  await runtime.startAgent("agent:a");
  runtime.postMessage({ text: "给出结论", attention: "team", idempotencyKey: "overflow:start" });
  await initialStarted;
  for (let index = 1; index <= 3; index += 1) {
    runtime.postMessage({
      text: `快速变化 ${String(index)}`,
      attention: ["human"],
      idempotencyKey: `overflow:change:${String(index)}`,
    });
  }
  releaseInitial?.();
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.equal(fullPromptCount, 2);
  assert.equal(reconciliationPromptCount, 0);
  assert.equal(snapshot.messages.at(-1)?.text, "@human 基于最新状态完整重算");
  assert.equal(snapshot.trace.filter((record) => record.kind === "agent.turn.started").length, 2);
  assert.equal(snapshot.trace.filter((record) => record.kind === "agent.draft.expired").length, 1);
  assert.equal(
    snapshot.trace.some(
      (record) =>
        record.kind === "agent.reconciliation.decided" &&
        record.data?.decision === "regenerate" &&
        record.data?.deltaOverflow === true,
    ),
    true,
  );
  await runtime.close();
});

test("a drop reconciliation acknowledges the trigger without publishing the stale candidate", async () => {
  const room = new InMemoryRoomLedger("room:reconciliation-drop");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let releaseInitial: (() => void) | undefined;
  let reportInitialStarted: (() => void) | undefined;
  const initialStarted = new Promise<void>((resolve) => {
    reportInitialStarted = resolve;
  });
  const holdInitial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: true,
    adapter: new ScriptedAgentAdapter("a", async ({ prompt }) => {
      if (prompt.text.startsWith("MESH INTERNAL RECONCILIATION")) {
        return JSON.stringify({
          decision: "drop",
          reason: "The human already supplied the requested answer.",
        });
      }
      reportInitialStarted?.();
      await holdInitial;
      return "@human 这条候选不应发送";
    }),
  });
  await runtime.startAgent("agent:a");
  const trigger = runtime.postMessage({
    text: "帮我回答",
    attention: "team",
    idempotencyKey: "drop:start",
  });
  await initialStarted;
  runtime.postMessage({
    text: "我已经自己解决了",
    attention: ["human"],
    idempotencyKey: "drop:resolved",
  });
  releaseInitial?.();
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.messages.some((message) => message.from === "agent:a"), false);
  const receipt = room.readEvents().find(
    (event) =>
      event.action === CoreAction.agentTurnComplete &&
      event.actorId === "agent:a",
  );
  assert.deepEqual(receipt?.payload, {
    kind: "agent-turn-completed",
    respondingTo: [trigger.id],
    outcome: "empty",
  });
  assert.equal(
    snapshot.trace.some(
      (record) =>
        record.kind === "agent.reconciliation.decided" && record.data?.decision === "drop",
    ),
    true,
  );
  assert.equal(snapshot.trace.some((record) => record.kind === "agent.draft.expired"), false);
  await runtime.close();
});

test("an unrelated task change does not dirty or reconcile an active thread turn", async () => {
  const room = new InMemoryRoomLedger("room:reconciliation-irrelevant");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let promptCount = 0;
  let releaseInitial: (() => void) | undefined;
  let reportInitialStarted: (() => void) | undefined;
  const initialStarted = new Promise<void>((resolve) => {
    reportInitialStarted = resolve;
  });
  const holdInitial = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: true,
    adapter: new ScriptedAgentAdapter("a", async () => {
      promptCount += 1;
      reportInitialStarted?.();
      await holdInitial;
      return "@human 完成";
    }),
  });
  await runtime.startAgent("agent:a");
  runtime.postMessage({ text: "处理线程", attention: "team", idempotencyKey: "irrelevant:start" });
  await initialStarted;
  runtime.createTask({ id: "task:unrelated", title: "无关任务" });
  releaseInitial?.();
  await runtime.settle();

  const snapshot = runtime.snapshot();
  assert.equal(promptCount, 1);
  assert.equal(snapshot.trace.some((record) => record.kind === "agent.turn.dirty"), false);
  assert.equal(snapshot.trace.some((record) => record.kind.startsWith("agent.reconciliation.")), false);
  await runtime.close();
});

test("a stale candidate reply remains visible in diagnostics without becoming a room message", async () => {
  const room = new InMemoryRoomLedger("room:expired-draft");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let arrivals = 0;
  let releaseFirstAttempts: (() => void) | undefined;
  const firstAttemptsReady = new Promise<void>((resolve) => {
    releaseFirstAttempts = resolve;
  });
  const counter = async ({ prompt }: { readonly prompt: { readonly text: string } }): Promise<string> => {
    if (prompt.text.startsWith("MESH INTERNAL RECONCILIATION")) {
      return JSON.stringify({
        decision: "regenerate",
        reason: "The count must be recomputed from the latest room state.",
      });
    }
    const retry = prompt.text.includes("room changed during your previous reasoning");
    if (!retry) {
      arrivals += 1;
      if (arrivals === 2) {
        releaseFirstAttempts?.();
      }
      await firstAttemptsReady;
    }
    const counts = [...prompt.text.matchAll(/"text":"报数 (\d+)/g)].map((match) =>
      Number.parseInt(match[1] ?? "0", 10),
    );
    return `报数 ${String(Math.max(0, ...counts) + 1)} @human`;
  };
  for (const id of ["a", "b"] as const) {
    runtime.registerAgent({
      id: `agent:${id}`,
      name: id.toUpperCase(),
      handle: id,
      respondToTeam: true,
      adapter: new ScriptedAgentAdapter(id, counter),
    });
    await runtime.startAgent(`agent:${id}`);
  }

  runtime.postMessage({ text: "报数！", attention: "team", idempotencyKey: "count:trace" });
  await runtime.settle();

  const snapshot = runtime.snapshot();
  const expired = snapshot.trace.filter((record) => record.kind === "agent.draft.expired");
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.content, "报数 1 @human");
  assert.equal(expired[0]?.status, "expired");
  const turnStarts = snapshot.trace.filter((record) => record.kind === "agent.turn.started");
  assert.equal(typeof turnStarts[0]?.correlationId, "string");
  assert.equal(new Set(turnStarts.map((record) => record.correlationId)).size, 1);
  assert.equal(expired[0]?.correlationId, turnStarts[0]?.correlationId);
  const waitingTransition = snapshot.trace.find(
    (record) => record.kind === "agent.session.status" && record.data?.toStatus === "waiting",
  );
  assert.equal(waitingTransition?.data?.fromStatus, "working");
  assert.equal(waitingTransition?.correlationId, turnStarts[0]?.correlationId);
  assert.equal(typeof waitingTransition?.data?.statusDurationMs, "number");
  assert.equal(
    snapshot.messages.some(
      (message) => message.from === expired[0]?.actorId && message.text === expired[0]?.content,
    ),
    false,
  );
  assert.equal(room.readEvents().some((event) => event.action.startsWith("agent.draft.")), false);
  await runtime.close();
});

test("every agent sees shared history while attention wakes only its recipients", async () => {
  const { runtime, turns } = runtimeWithTwoAgents();
  await runtime.startAgent("agent:a");
  await runtime.startAgent("agent:b");
  runtime.postMessage({
    text: "private attention, shared fact",
    attention: ["agent:a"],
    idempotencyKey: "shared:fact",
  });
  await runtime.settle();

  assert.equal(turns.get("agent:a"), 1);
  assert.equal(turns.get("agent:b"), 1, "B should wake only after A explicitly mentions B");
  assert.equal(runtime.snapshot().messages[0]?.text, "private attention, shared fact");
  await runtime.close();
});

test("tasks project from create, exclusive claim, and state updates", async () => {
  const { runtime } = runtimeWithTwoAgents();
  runtime.createTask({ id: "task:1", title: "Implement auth" });
  const claim = runtime.claimTask("task:1", "agent:a");
  const competing = runtime.claimTask("task:1", "agent:b");
  const update = runtime.updateTask({ taskId: "task:1", status: "review", actorId: "agent:a" });

  assert.equal(claim.status, "committed");
  assert.equal(competing.status, "rejected");
  assert.equal(update.status, "committed");
  assert.deepEqual(runtime.snapshot().tasks, [
    {
      id: "task:1",
      title: "Implement auth",
      status: "review",
      ownerId: "agent:a",
      version: 3,
      updatedAt: runtime.snapshot().tasks[0]?.updatedAt,
    },
  ]);
  await runtime.close();
});

test("restart resumes from durable cursor without replaying completed turns", async () => {
  const room = new InMemoryRoomLedger("room:restart");
  const cursors = new InMemoryCursorStore();
  let turns = 0;
  const runtime = new CollaborationRuntime({ room, cursors, cwd: process.cwd() });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("script", () => {
      turns += 1;
      return "@human done";
    }),
  });
  await runtime.startAgent("agent:a");
  runtime.postMessage({ text: "one", attention: ["agent:a"], idempotencyKey: "one" });
  await runtime.settle();
  await runtime.restartAgent("agent:a");
  await runtime.settle();
  assert.equal(turns, 1);

  runtime.postMessage({ text: "two", attention: ["agent:a"], idempotencyKey: "two" });
  await runtime.settle();
  assert.equal(turns, 2);
  await runtime.close();
});

test("room messages remain typed projections", async () => {
  const { runtime, room } = runtimeWithTwoAgents();
  const event = runtime.postMessage({ text: "hello", attention: "team" });
  const payload = event.payload satisfies RoomMessagePayload;
  assert.equal(payload.kind, "message");
  assert.equal(room.headSequence, 1);
  await runtime.close();
});

test("a mention followed by sentence punctuation still routes attention", async () => {
  const room = new InMemoryRoomLedger("room:punctuation");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("a", () => "Please continue, @b."),
  });
  runtime.registerAgent({
    id: "agent:b",
    name: "B",
    handle: "b",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("b", () => "@human done"),
  });
  await runtime.startAgent("agent:a");
  await runtime.startAgent("agent:b");
  runtime.postMessage({ text: "go", attention: ["agent:a"] });
  await runtime.settle();
  assert.deepEqual(runtime.snapshot().messages[1]?.attention, ["agent:b"]);
  assert.equal(runtime.snapshot().messages[2]?.from, "agent:b");
  await runtime.close();
});

test("agent receives the complete shared room history even after its cursor advances", async () => {
  const room = new InMemoryRoomLedger("room:full-context");
  const cursors = new InMemoryCursorStore();
  let lastPrompt = "";
  const runtime = new CollaborationRuntime({ room, cursors, cwd: process.cwd() });
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("script", ({ prompt }) => {
      lastPrompt = prompt.text;
      return "@human seen";
    }),
  });
  await runtime.startAgent("agent:a");
  runtime.postMessage({ text: "shared background", attention: ["human"], idempotencyKey: "bg" });
  await runtime.settle();
  runtime.postMessage({ text: "please act", attention: ["agent:a"], idempotencyKey: "act" });
  await runtime.settle();
  assert.match(lastPrompt, /shared background/);
  assert.match(lastPrompt, /please act/);
  await runtime.close();
});

test("a failed turn can be stopped, restarted, and retried from its unacknowledged cursor", async () => {
  const room = new InMemoryRoomLedger("room:failed-turn");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let turns = 0;
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    respondToTeam: false,
    adapter: new ScriptedAgentAdapter("script", () => {
      turns += 1;
      if (turns === 1) {
        throw new Error("transient turn failure");
      }
      return "@human recovered";
    }),
  });
  await runtime.startAgent("agent:a");
  runtime.postMessage({ text: "retry me", attention: ["agent:a"] });
  await runtime.settle();
  assert.equal(runtime.snapshot().agents[0]?.state, "error");

  await runtime.restartAgent("agent:a");
  await runtime.settle();
  assert.equal(turns, 2);
  assert.equal(runtime.snapshot().messages.at(-1)?.text, "@human recovered");
  await runtime.close();
});

test("adapter start failures become durable error presence", async () => {
  const room = new InMemoryRoomLedger("room:start-failure");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  const unavailable: AgentAdapter = {
    kind: "unavailable",
    capabilities: {
      persistentSession: false,
      streaming: false,
      cancel: false,
      loadSession: false,
      transport: "native",
    },
    probe: async () => ({ available: false, command: "missing" }),
    start: async () => {
      throw new Error("adapter failed to start");
    },
  };
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    adapter: unavailable,
  });

  await assert.rejects(runtime.startAgent("agent:a"), /adapter failed to start/);
  assert.equal(runtime.snapshot().agents[0]?.state, "error");
  assert.match(runtime.snapshot().agents[0]?.detail ?? "", /failed to start/);
  await runtime.close();
});

test("runtime close fences a concurrent Agent start and stops the late session", async () => {
  const room = new InMemoryRoomLedger("room:close-during-start");
  const runtime = new CollaborationRuntime({
    room,
    cursors: new InMemoryCursorStore(),
    cwd: process.cwd(),
  });
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let stops = 0;
  const adapter: AgentAdapter = {
    kind: "deferred-start",
    capabilities: {
      persistentSession: true,
      streaming: false,
      cancel: true,
      loadSession: true,
      transport: "scripted",
    },
    probe: async () => ({ available: true, command: "deferred-start" }),
    start: async (config) => {
      await startGate;
      return {
        id: "deferred:1",
        agentId: config.agentId,
        capabilities: adapter.capabilities,
        status: "ready",
        prompt: async (input) => ({
          turnId: input.turnId,
          text: "",
          stopReason: "completed",
        }),
        cancel: async () => undefined,
        events: async function* () {
          return;
        },
        stop: async () => {
          stops += 1;
        },
      };
    },
  };
  runtime.registerAgent({
    id: "agent:a",
    name: "A",
    handle: "a",
    adapter,
  });

  const starting = runtime.startAgent("agent:a");
  const closing = runtime.close();
  await assert.rejects(runtime.startAgent("agent:a"), /closing/);
  releaseStart?.();
  await Promise.all([starting, closing]);
  assert.equal(stops, 1);
});
