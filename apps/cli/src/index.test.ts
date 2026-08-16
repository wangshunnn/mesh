import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const cli = fileURLToPath(new URL("./index.js", import.meta.url));

test("CLI previews config without creating workspace state", () => {
  const { root, meshHome } = cliFixture("mesh-cli-preview-");
  const preview = JSON.parse(run(["config", "preview", "--root", root], meshHome)) as {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly projectKey: string;
    readonly source: string;
    readonly revision: string | null;
    readonly configPath: string;
    readonly config: { readonly version: number };
  };

  assert.equal(preview.source, "default");
  assert.equal(preview.revision, null);
  assert.equal(preview.config.version, 1);
  assert.equal(
    preview.configPath,
    join(meshHome, "sessions", preview.projectKey, preview.sessionId, "config.json"),
  );
  assert.equal(existsSync(meshHome), false);
  assert.equal(existsSync(join(root, ".mesh")), false);
});

test("CLI validates raw configs and preview edit documents without creating workspace state", () => {
  const { root, meshHome } = cliFixture("mesh-cli-validate-");
  const rawPath = join(root, "config.json");
  writeFileSync(rawPath, '{"version":1,"roomId":"room:validate","agents":[]}\n', "utf8");
  assert.match(run(["config", "validate", rawPath, "--root", root], meshHome), /v1: 0 agent/);

  const previewPath = join(root, "preview.json");
  writeFileSync(previewPath, run(["config", "preview", "--root", root], meshHome), "utf8");
  assert.match(run(["config", "validate", previewPath, "--root", root], meshHome), /v1: 2 agent/);
  assert.equal(existsSync(meshHome), false);
  assert.equal(existsSync(join(root, ".mesh")), false);
});

test("CLI applies an edited preview and rejects a stale revision", () => {
  const { root, meshHome } = cliFixture("mesh-cli-apply-");
  const preview = JSON.parse(run(["config", "preview", "--root", root], meshHome)) as {
    readonly config: { readonly roomId: string };
  };
  const edit = {
    ...preview,
    config: { ...preview.config, roomId: "room:cli-applied" },
  };
  const editPath = join(root, "config-edit.json");
  writeFileSync(editPath, `${JSON.stringify(edit, undefined, 2)}\n`, "utf8");

  const applied = JSON.parse(run(["config", "apply", editPath, "--root", root], meshHome)) as {
    readonly changed: boolean;
    readonly revision: string | null;
    readonly config: { readonly roomId: string };
  };
  assert.equal(applied.changed, true);
  assert.match(applied.revision ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(applied.config.roomId, "room:cli-applied");
  assert.equal(
    JSON.parse(run(["config", "preview", "--root", root], meshHome)).config.roomId,
    "room:cli-applied",
  );
  assert.throws(
    () => run(["config", "apply", editPath, "--root", root], meshHome),
    /changed after it was read/,
  );

  const otherRoot = join(root, "other");
  mkdirSync(otherRoot);
  assert.throws(
    () => run(["config", "apply", editPath, "--root", otherRoot], meshHome),
    /belongs to a different workspace/,
  );
  assert.equal(existsSync(join(otherRoot, ".mesh")), false);
});

test("CLI persists a task across independent invocations", () => {
  const { root, meshHome } = cliFixture("mesh-cli-");
  const created = run(["task", "create", "CLI task", "--root", root], meshHome);
  assert.match(created, /Created .*: CLI task/);

  const listed = run(["task", "list", "--root", root], meshHome);
  assert.match(listed, /\[todo\] CLI task/);
  const status = run(["status", "--root", root], meshHome);
  assert.match(status, /Tasks: 1/);
});

test("CLI creates, lists, and explicitly reopens isolated sessions", () => {
  const { root, meshHome } = cliFixture("mesh-cli-sessions-");
  run(["message", "First session", "--root", root], meshHome);
  const firstList = run(["session", "list", "--root", root], meshHome);
  const firstId = firstList.match(/session-[0-9a-f-]{36}/)?.[0];
  assert.ok(firstId);
  assert.match(firstList, /First session \[1 messages, ok\]/);

  const created = run(["session", "new", "--root", root], meshHome);
  const secondId = created.match(/session-[0-9a-f-]{36}/)?.[0];
  assert.ok(secondId);
  assert.notEqual(secondId, firstId);
  assert.match(created, new RegExp(`sessions/.+/${secondId}$`, "m"));

  const sessions = run(["session", "list", "--root", root], meshHome);
  assert.ok(sessions.indexOf(secondId) < sessions.indexOf(firstId));
  assert.match(sessions, new RegExp(`${secondId} New Session \\[0 messages, ok\\]`));
  assert.match(
    run(["status", "--root", root, "--session", firstId], meshHome),
    /Messages: 1/,
  );
  assert.throws(
    () =>
      run(
        [
          "status",
          "--root",
          root,
          "--session",
          "session-00000000-0000-4000-8000-000000000000",
        ],
        meshHome,
      ),
    /Unknown Mesh session/,
  );
});

function run(args: readonly string[], meshHome: string): string {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, MESH_HOME: meshHome, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cliFixture(prefix: string): { readonly root: string; readonly meshHome: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const root = join(directory, "project");
  mkdirSync(root);
  return Object.freeze({ root, meshHome: join(directory, "mesh-home") });
}
