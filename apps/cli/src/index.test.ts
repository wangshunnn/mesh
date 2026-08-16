import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const cli = fileURLToPath(new URL("./index.js", import.meta.url));

test("CLI previews config without creating workspace state", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-cli-preview-"));
  const preview = JSON.parse(run(["config", "preview", "--root", root])) as {
    readonly source: string;
    readonly revision: string | null;
    readonly configPath: string;
    readonly config: { readonly version: number };
  };

  assert.equal(preview.source, "default");
  assert.equal(preview.revision, null);
  assert.equal(preview.config.version, 1);
  assert.equal(preview.configPath, join(root, ".mesh", "config.json"));
  assert.equal(existsSync(join(root, ".mesh")), false);
});

test("CLI validates raw configs and preview edit documents without creating workspace state", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-cli-validate-"));
  const rawPath = join(root, "config.json");
  writeFileSync(rawPath, '{"version":1,"roomId":"room:validate","agents":[]}\n', "utf8");
  assert.match(run(["config", "validate", rawPath, "--root", root]), /v1: 0 agent/);

  const previewPath = join(root, "preview.json");
  writeFileSync(previewPath, run(["config", "preview", "--root", root]), "utf8");
  assert.match(run(["config", "validate", previewPath, "--root", root]), /v1: 2 agent/);
  assert.equal(existsSync(join(root, ".mesh")), false);
});

test("CLI applies an edited preview and rejects a stale revision", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-cli-apply-"));
  const preview = JSON.parse(run(["config", "preview", "--root", root])) as {
    readonly config: { readonly roomId: string };
  };
  const edit = {
    ...preview,
    config: { ...preview.config, roomId: "room:cli-applied" },
  };
  const editPath = join(root, "config-edit.json");
  writeFileSync(editPath, `${JSON.stringify(edit, undefined, 2)}\n`, "utf8");

  const applied = JSON.parse(run(["config", "apply", editPath, "--root", root])) as {
    readonly changed: boolean;
    readonly revision: string | null;
    readonly config: { readonly roomId: string };
  };
  assert.equal(applied.changed, true);
  assert.match(applied.revision ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(applied.config.roomId, "room:cli-applied");
  assert.equal(
    JSON.parse(run(["config", "preview", "--root", root])).config.roomId,
    "room:cli-applied",
  );
  assert.throws(
    () => run(["config", "apply", editPath, "--root", root]),
    /changed after it was read/,
  );

  const otherRoot = mkdtempSync(join(tmpdir(), "mesh-cli-apply-other-"));
  assert.throws(
    () => run(["config", "apply", editPath, "--root", otherRoot]),
    /belongs to a different workspace/,
  );
  assert.equal(existsSync(join(otherRoot, ".mesh")), false);
});

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
    stdio: ["ignore", "pipe", "pipe"],
  });
}
