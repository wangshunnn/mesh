import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const sessions = new Set<string>();
let nextSession = 1;

const app = acp
  .agent({ name: "mesh-fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { resume: {}, close: {} },
    },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `acp:${String(nextSession)}`;
    nextSession += 1;
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    sessions.add(params.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) {
      throw new Error(`Unknown fake session ${params.sessionId}.`);
    }
    const text = params.prompt
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "echo:" },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fake-tool",
        title: "Fake tool",
        status: "in_progress",
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
app.connect(stream);
