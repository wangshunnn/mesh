import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const cli = fileURLToPath(new URL("./index.js", import.meta.url));

test("CLI persists a task across independent invocations", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  const created = run(["task", "create", "CLI task", "--root", root]);
  assert.match(created, /Created .*: CLI task/);

  const listed = run(["task", "list", "--root", root]);
  assert.match(listed, /\[todo\] CLI task/);
  const status = run(["status", "--root", root]);
  assert.match(status, /Tasks: 1/);
});

function run(args: readonly string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}
