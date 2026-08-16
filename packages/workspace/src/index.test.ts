import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MeshWorkspace,
  defaultWorkspaceConfig,
  previewWorkspaceConfig,
  validateWorkspaceConfig,
} from "./index.js";

test("previewing a default workspace config has no filesystem side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-workspace-preview-"));
  const preview = previewWorkspaceConfig({ root });

  assert.equal(preview.source, "default");
  assert.equal(preview.config.version, 1);
  assert.equal(preview.config.agents.length, 2);
  assert.equal(existsSync(join(root, ".mesh")), false);
});

test("opening a workspace creates reusable local configuration and SQLite state", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-workspace-"));
  const first = MeshWorkspace.open({ root });
  assert.equal(existsSync(first.configPath), true);
  assert.equal(existsSync(first.databasePath), true);
  assert.equal(first.configPreview().source, "default");
  assert.equal(first.configPreview().root, root);
  first.postText("persistent", { idempotencyKey: "persistent" });
  await first.close();

  const reopened = MeshWorkspace.open({ root });
  assert.equal(reopened.configPreview().source, "file");
  assert.equal(reopened.snapshot().messages[0]?.text, "persistent");
  assert.equal(JSON.parse(readFileSync(reopened.configPath, "utf8")).version, 1);
  await reopened.close();
});

test("mentions resolve to attention while unaddressed text stays team-visible", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-workspace-"));
  const workspace = MeshWorkspace.open({ root });
  assert.deepEqual(workspace.resolveAttention("@codex review this"), ["agent:codex"]);
  assert.deepEqual(workspace.resolveAttention("handoff to @codex."), ["agent:codex"]);
  assert.deepEqual(workspace.resolveAttention("@agent:opencode inspect"), ["agent:opencode"]);
  assert.equal(workspace.resolveAttention("hello everyone"), "team");
  assert.equal(workspace.resolveAttention("@team status"), "team");
  await workspace.close();
});

test("workspace config rejects duplicate and unsupported adapters", () => {
  const valid = defaultWorkspaceConfig();
  assert.equal(validateWorkspaceConfig(valid).agents.length, 2);
  assert.ok(valid.agents.every((agent) => agent.respondToTeam === true));
  assert.throws(
    () =>
      validateWorkspaceConfig({
        version: 1,
        roomId: "room",
        agents: [
          { id: "a", name: "A", handle: "same", adapter: "codex-native" },
          { id: "b", name: "B", handle: "same", adapter: "opencode-acp" },
        ],
      }),
    /duplicates/,
  );
  assert.throws(
    () =>
      validateWorkspaceConfig({
        version: 1,
        roomId: "room",
        agents: [{ id: "a", name: "A", handle: "a", adapter: "unknown" }],
      }),
    /unsupported adapter/,
  );
});
