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
