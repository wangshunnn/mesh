const input: Uint8Array[] = [];

process.stdin.on("data", (chunk: Uint8Array) => input.push(chunk));
process.stdin.on("end", () => {
  const mode = process.argv[2] ?? "initial";
  const sessionId = process.argv[3] ?? "fake-native-session";
  const prompt = Buffer.concat(input).toString("utf8");
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: `${mode}:${prompt}` },
    })}\n`,
  );
});
