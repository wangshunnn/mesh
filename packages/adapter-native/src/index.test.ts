import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { NativeCommandAdapter, parseCodexJsonLine } from "./index.js";

test("parses Codex thread identity", () => {
  assert.deepEqual(parseCodexJsonLine('{"type":"thread.started","thread_id":"abc"}'), {
    type: "session",
    sessionId: "abc",
  });
});

test("parses Codex final agent message", () => {
  assert.deepEqual(
    parseCodexJsonLine(
      '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"hello"}}',
    ),
    { type: "text-delta", delta: "hello" },
  );
});

test("ignores unrelated Codex JSON events", () => {
  assert.equal(parseCodexJsonLine('{"type":"turn.completed","usage":{}}'), undefined);
});

test("native command sessions retain identity across process-per-turn resumes", async () => {
  const fixture = fileURLToPath(new URL("./fake-native-fixture.js", import.meta.url));
  const adapter = new NativeCommandAdapter({
    kind: "fake-native",
    command: process.execPath,
    streaming: false,
    buildInitialArgs: () => [fixture, "initial", "native:1"],
    buildResumeArgs: (_config, sessionId) => [fixture, "resume", sessionId],
    parseLine: parseCodexJsonLine,
  });
  const session = await adapter.start({
    agentId: "native",
    cwd: process.cwd(),
    systemPrompt: "system",
  });

  const first = await session.prompt({ turnId: "turn:1", text: "hello" });
  assert.equal(first.text, "initial:system\n\nhello");
  assert.equal(session.id, "native:1");

  const second = await session.prompt({ turnId: "turn:2", text: "again" });
  assert.equal(second.text, "resume:again");
  assert.equal(session.id, "native:1");
  await session.stop();
});

test("Codex adapter is conservative about streaming and permissions", async () => {
  const fixture = fileURLToPath(new URL("./fake-native-fixture.js", import.meta.url));
  const adapter = new NativeCommandAdapter({
    kind: "shape",
    command: process.execPath,
    streaming: false,
    buildInitialArgs: () => [fixture],
    buildResumeArgs: () => [fixture],
    parseLine: parseCodexJsonLine,
  });
  assert.equal(adapter.capabilities.streaming, false);
  assert.equal(adapter.capabilities.transport, "native");
});
