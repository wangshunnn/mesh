import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScriptedAgentAdapter } from "@ai-mesh/agent";

import {
  MeshWorkspace,
  WorkspaceAdapterRegistry,
  WorkspaceConfigConflictError,
  WorkspaceConfigLockedError,
  defaultWorkspaceConfig,
  parseWorkspaceConfig,
  previewWorkspaceConfig,
  saveWorkspaceConfig,
  serializeWorkspaceConfig,
  validateWorkspaceConfig,
} from "./index.js";

test("previewing a default workspace config has no filesystem side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-workspace-preview-"));
  const preview = previewWorkspaceConfig({ root });

  assert.equal(preview.source, "default");
  assert.equal(preview.revision, null);
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
  assert.match(first.configPreview().revision ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.configPreview().root, root);
  const firstRevision = first.configPreview().revision;
  first.postText("persistent", { idempotencyKey: "persistent" });
  await first.close();

  const reopened = MeshWorkspace.open({ root });
  assert.equal(reopened.configPreview().source, "file");
  assert.equal(reopened.configPreview().revision, firstRevision);
  assert.equal(reopened.snapshot().messages[0]?.text, "persistent");
  assert.equal(JSON.parse(readFileSync(reopened.configPath, "utf8")).version, 1);
  await reopened.close();
});

test("config version 1 has a canonical round trip for every current field", () => {
  const config = {
    version: 1 as const,
    roomId: "room:round-trip",
    agents: [
      {
        id: "agent:codex",
        name: "Codex",
        handle: "@CODEX",
        adapter: "codex-native" as const,
        command: "/opt/codex/bin/codex",
        permissionPolicy: "allow-once" as const,
        respondToTeam: false,
        systemPrompt: "Review the shared Room state.",
      },
    ],
  };

  const serialized = serializeWorkspaceConfig(config);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(parseWorkspaceConfig(serialized), {
    ...config,
    agents: [{ ...config.agents[0], handle: "codex" }],
  });
  assert.throws(() => parseWorkspaceConfig("{"), /invalid JSON/);
});

test("config saves are atomic, revision checked, and no-op when already canonical", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-workspace-save-"));
  const initial = previewWorkspaceConfig({ root });
  const firstConfig = { ...initial.config, roomId: "room:first" };
  const first = saveWorkspaceConfig({
    root,
    config: firstConfig,
    expectedRevision: initial.revision,
  });

  assert.equal(first.changed, true);
  assert.equal(first.source, "file");
  assert.match(first.revision ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parseWorkspaceConfig(readFileSync(first.configPath, "utf8")), firstConfig);

  const unchanged = saveWorkspaceConfig({
    root,
    config: firstConfig,
    expectedRevision: first.revision,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.revision, first.revision);

  const second = saveWorkspaceConfig({
    root,
    config: { ...firstConfig, roomId: "room:second" },
    expectedRevision: first.revision,
  });
  assert.throws(
    () =>
      saveWorkspaceConfig({
        root,
        config: { ...firstConfig, roomId: "room:stale" },
        expectedRevision: first.revision,
      }),
    (error: unknown) =>
      error instanceof WorkspaceConfigConflictError &&
      error.expectedRevision === first.revision &&
      error.actualRevision === second.revision,
  );
  assert.equal(previewWorkspaceConfig({ root }).config.roomId, "room:second");
  assert.deepEqual(
    readdirSync(first.dataDirectory).filter(
      (entry) => entry.endsWith(".lock") || entry.endsWith(".tmp"),
    ),
    [],
  );
});

test("config save validates before creating state and serializes writers", () => {
  const invalidRoot = mkdtempSync(join(tmpdir(), "mesh-workspace-save-invalid-"));
  assert.throws(
    () =>
      saveWorkspaceConfig({
        root: invalidRoot,
        config: { version: 2, roomId: "room:invalid", agents: [] } as never,
        expectedRevision: null,
      }),
    /must use version 1/,
  );
  assert.equal(existsSync(join(invalidRoot, ".mesh")), false);

  const lockedRoot = mkdtempSync(join(tmpdir(), "mesh-workspace-save-locked-"));
  const preview = previewWorkspaceConfig({ root: lockedRoot });
  const lockPath = `${preview.configPath}.lock`;
  saveWorkspaceConfig({
    root: lockedRoot,
    config: preview.config,
    expectedRevision: preview.revision,
  });
  writeFileSync(lockPath, "another writer\n", "utf8");
  assert.throws(
    () =>
      saveWorkspaceConfig({
        root: lockedRoot,
        config: preview.config,
        expectedRevision: previewWorkspaceConfig({ root: lockedRoot }).revision,
      }),
    WorkspaceConfigLockedError,
  );
  rmSync(lockPath);
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
  assert.throws(
    () =>
      validateWorkspaceConfig({
        version: 1,
        roomId: "room",
        agents: [
          {
            id: "a",
            name: "A",
            handle: "a",
            adapter: "codex-native",
            command: 42,
          },
        ],
      }),
    /invalid command/,
  );
  assert.throws(
    () =>
      validateWorkspaceConfig({
        version: 1,
        roomId: "room",
        agents: [],
        futureField: true,
      }),
    /unknown futureField/,
  );
});

test("workspace composition resolves adapters through an immutable provider registry", async () => {
  const provider = Object.freeze({
    kind: "codex-native" as const,
    create: () => new ScriptedAgentAdapter("test-codex", () => "@human done"),
  });
  const registry = new WorkspaceAdapterRegistry([provider]);
  assert.deepEqual(registry.kinds(), ["codex-native"]);
  assert.throws(
    () => new WorkspaceAdapterRegistry([provider, provider]),
    /Duplicate workspace adapter provider/,
  );

  const root = mkdtempSync(join(tmpdir(), "mesh-workspace-provider-"));
  const workspace = MeshWorkspace.open({
    root,
    adapterRegistry: registry,
    config: {
      version: 1,
      roomId: "room:provider-test",
      agents: [
        {
          id: "agent:test",
          name: "Test",
          handle: "test",
          adapter: "codex-native",
        },
      ],
    },
  });
  const probes = await workspace.probeAgents();
  assert.equal(probes[0]?.availability.available, true);
  assert.equal(probes[0]?.availability.command, "test-codex");
  await workspace.close();
});
