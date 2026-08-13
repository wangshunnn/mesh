import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AcpProcessAdapter } from "./index.js";

test("ACP process adapter initializes, streams updates, and closes", async () => {
  const fixture = fileURLToPath(new URL("./fake-agent-fixture.js", import.meta.url));
  const adapter = new AcpProcessAdapter({
    kind: "fake-acp",
    command: process.execPath,
    args: [fixture],
  });
  const session = await adapter.start({
    agentId: "acp-agent",
    cwd: process.cwd(),
    systemPrompt: "system",
  });
  const events = session.events()[Symbol.asyncIterator]();

  const result = await session.prompt({ turnId: "turn:1", text: "hello" });
  assert.equal(result.text, "echo:system\n\nhello");
  assert.equal(result.stopReason, "completed");
  assert.equal(session.id, "acp:1");

  const second = await session.prompt({ turnId: "turn:2", text: "again" });
  assert.equal(second.text, "echo:again");

  const received = await Promise.all(Array.from({ length: 10 }, () => events.next()));
  assert.deepEqual(
    received.map((entry) => entry.value?.type),
    [
      "status",
      "text-delta",
      "tool-call",
      "text-delta",
      "status",
      "status",
      "text-delta",
      "tool-call",
      "text-delta",
      "status",
    ],
  );
  await events.return?.();
  await session.stop();
  assert.equal(session.status, "stopped");
});

test("ACP process adapter resumes an existing vendor session", async () => {
  const fixture = fileURLToPath(new URL("./fake-agent-fixture.js", import.meta.url));
  const adapter = new AcpProcessAdapter({
    kind: "fake-acp",
    command: process.execPath,
    args: [fixture],
  });
  const session = await adapter.start({
    agentId: "acp-agent",
    cwd: process.cwd(),
    sessionId: "acp:persisted",
  });
  const result = await session.prompt({ turnId: "turn:resume", text: "again" });
  assert.equal(session.id, "acp:persisted");
  assert.equal(result.text, "echo:again");
  await session.stop();
});

test("ACP process adapter rejects relative workspace roots", async () => {
  const adapter = new AcpProcessAdapter({ kind: "fake-acp", command: process.execPath });
  await assert.rejects(
    adapter.start({ agentId: "acp-agent", cwd: "relative" }),
    /cwd must be absolute/,
  );
});
