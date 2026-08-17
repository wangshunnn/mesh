import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScriptedAgentAdapter } from "@ai-mesh/agent";
import { CoreAction } from "@ai-mesh/protocol";
import { SqliteStore } from "@ai-mesh/store-sqlite";

import {
  MeshWorkspace,
  WorkspaceAdapterRegistry,
  WorkspaceConfigConflictError,
  WorkspaceConfigLockedError,
  WorkspaceMigrationConflictError,
  WorkspaceStorageOverlapError,
  archiveRegisteredWorkspaceSession,
  defaultWorkspaceConfig,
  listRegisteredWorkspaceSessions,
  listWorkspaceRegistrations,
  listWorkspaceSessions,
  parseWorkspaceConfig,
  previewWorkspaceConfig,
  saveWorkspaceConfig,
  serializeWorkspaceConfig,
  validateWorkspaceConfig,
  workspaceProjectKey,
} from "./index.js";

test("previewing a default workspace config has no filesystem side effects", () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-preview-");
  const preview = previewWorkspaceConfig({ root, meshHome });

  assert.equal(preview.source, "default");
  assert.equal(preview.revision, null);
  assert.equal(preview.config.version, 1);
  assert.equal(preview.config.agents.length, 2);
  assert.equal(preview.meshHome, meshHome);
  assert.match(preview.workspaceId, /^[0-9a-f-]{36}$/);
  assert.match(preview.sessionId, /^session-[0-9a-f-]{36}$/);
  assert.equal(preview.projectKey, workspaceProjectKey(root));
  assert.equal(
    preview.dataDirectory,
    join(meshHome, "sessions", preview.projectKey, preview.sessionId),
  );
  assert.equal(preview.sessionDirectory, preview.dataDirectory);
  assert.equal(preview.registryPath, join(meshHome, "storages", "workspace.json"));
  assert.equal(
    preview.projectionCachePath,
    join(meshHome, "storages", "session-projection-cache.json"),
  );
  assert.equal(preview.headerPath, join(preview.sessionDirectory, "header.json"));
  assert.equal(preview.configPath, join(preview.sessionDirectory, "config.json"));
  assert.equal(preview.databasePath, join(preview.sessionDirectory, "mesh.db"));
  assert.equal(existsSync(meshHome), false);
  assert.equal(existsSync(join(root, ".mesh")), false);
});

test("opening a workspace registers a reusable session with a strict header and SQLite state", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-");
  const first = MeshWorkspace.open({ root, meshHome });
  assert.equal(existsSync(first.configPath), true);
  assert.equal(existsSync(first.databasePath), true);
  assert.equal(first.dataDirectory.startsWith(join(meshHome, "sessions")), true);
  assert.deepEqual(JSON.parse(readFileSync(first.headerPath, "utf8")), {
    version: 1,
    id: first.sessionId,
    workspaceId: first.workspaceId,
    cwd: root,
    createdAt: JSON.parse(readFileSync(first.headerPath, "utf8")).createdAt,
  });
  assert.equal(existsSync(first.registryPath), true);
  assert.equal(existsSync(join(root, ".mesh")), false);
  assert.equal(first.configPreview().source, "default");
  assert.match(first.configPreview().revision ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.configPreview().root, root);
  const firstRevision = first.configPreview().revision;
  first.postText("persistent", { idempotencyKey: "persistent" });
  await first.close();

  const reopened = MeshWorkspace.open({ root, meshHome });
  assert.equal(reopened.workspaceId, first.workspaceId);
  assert.equal(reopened.sessionId, first.sessionId);
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
  const { root, meshHome } = workspaceFixture("mesh-workspace-save-");
  const initial = previewWorkspaceConfig({ root, meshHome });
  const firstConfig = { ...initial.config, roomId: "room:first" };
  const first = saveWorkspaceConfig({
    workspaceId: initial.workspaceId,
    sessionId: initial.sessionId,
    root,
    meshHome,
    config: firstConfig,
    expectedRevision: initial.revision,
  });

  assert.equal(first.changed, true);
  assert.equal(first.source, "file");
  assert.match(first.revision ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parseWorkspaceConfig(readFileSync(first.configPath, "utf8")), firstConfig);

  const unchanged = saveWorkspaceConfig({
    workspaceId: first.workspaceId,
    sessionId: first.sessionId,
    root,
    meshHome,
    config: firstConfig,
    expectedRevision: first.revision,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.revision, first.revision);

  const second = saveWorkspaceConfig({
    workspaceId: first.workspaceId,
    sessionId: first.sessionId,
    root,
    meshHome,
    config: { ...firstConfig, roomId: "room:second" },
    expectedRevision: first.revision,
  });
  assert.throws(
    () =>
      saveWorkspaceConfig({
        workspaceId: first.workspaceId,
        sessionId: first.sessionId,
        root,
        meshHome,
        config: { ...firstConfig, roomId: "room:stale" },
        expectedRevision: first.revision,
      }),
    (error: unknown) =>
      error instanceof WorkspaceConfigConflictError &&
      error.expectedRevision === first.revision &&
      error.actualRevision === second.revision,
  );
  assert.equal(previewWorkspaceConfig({ root, meshHome }).config.roomId, "room:second");
  assert.deepEqual(
    readdirSync(first.dataDirectory).filter(
      (entry) => entry.endsWith(".lock") || entry.endsWith(".tmp"),
    ),
    [],
  );
});

test("config save validates before creating state and serializes writers", () => {
  const invalid = workspaceFixture("mesh-workspace-save-invalid-");
  const invalidPreview = previewWorkspaceConfig(invalid);
  assert.throws(
    () =>
      saveWorkspaceConfig({
        ...invalid,
        workspaceId: invalidPreview.workspaceId,
        sessionId: invalidPreview.sessionId,
        config: { version: 2, roomId: "room:invalid", agents: [] } as never,
        expectedRevision: null,
      }),
    /must use version 1/,
  );
  assert.equal(existsSync(invalid.meshHome), false);
  assert.equal(existsSync(join(invalid.root, ".mesh")), false);

  const locked = workspaceFixture("mesh-workspace-save-locked-");
  const preview = previewWorkspaceConfig(locked);
  const lockPath = `${preview.configPath}.lock`;
  saveWorkspaceConfig({
    ...locked,
    workspaceId: preview.workspaceId,
    sessionId: preview.sessionId,
    config: preview.config,
    expectedRevision: preview.revision,
  });
  writeFileSync(lockPath, "another writer\n", "utf8");
  assert.throws(
    () =>
      saveWorkspaceConfig({
        ...locked,
        workspaceId: preview.workspaceId,
        sessionId: preview.sessionId,
        config: preview.config,
        expectedRevision: previewWorkspaceConfig(locked).revision,
      }),
    WorkspaceConfigLockedError,
  );
  rmSync(lockPath);
});

test("mentions resolve to attention while unaddressed text stays team-visible", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-");
  const workspace = MeshWorkspace.open({ root, meshHome });
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

  const { root, meshHome } = workspaceFixture("mesh-workspace-provider-");
  const workspace = MeshWorkspace.open({
    root,
    meshHome,
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

test("workspace registrations distinguish same-name directories and stay outside projects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-workspace-registry-"));
  const meshHome = join(directory, "mesh-home");
  const firstRoot = join(directory, "one", "project");
  const secondRoot = join(directory, "two", "project");
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  const canonicalFirstRoot = realpathSync(firstRoot);
  const canonicalSecondRoot = realpathSync(secondRoot);

  const first = MeshWorkspace.open({ root: firstRoot, meshHome });
  const second = MeshWorkspace.open({ root: secondRoot, meshHome });
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.notEqual(first.projectKey, second.projectKey);
  assert.deepEqual(
    listWorkspaceRegistrations({ meshHome }).map(({ id, root, name }) => ({ id, root, name })),
    [
      { id: second.workspaceId, root: canonicalSecondRoot, name: "project" },
      { id: first.workspaceId, root: canonicalFirstRoot, name: "project" },
    ],
  );
  assert.equal(existsSync(join(firstRoot, ".mesh")), false);
  assert.equal(existsSync(join(secondRoot, ".mesh")), false);
  await first.close();
  await second.close();
});

test("one workspace owns ordered isolated sessions with cold sidebar projections", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-sessions-");
  const first = MeshWorkspace.open({ root, meshHome });
  first.postText("First session title", { idempotencyKey: "first-title" });
  first.postText("First session latest message", { idempotencyKey: "first-latest" });
  const firstId = first.sessionId;
  await first.close();

  const second = MeshWorkspace.open({ root, meshHome, createSession: true });
  assert.equal(second.workspaceId, first.workspaceId);
  assert.notEqual(second.sessionId, firstId);
  assert.deepEqual(second.snapshot().messages, []);
  second.postText("Second session title", { idempotencyKey: "second-title" });
  const secondId = second.sessionId;
  await second.close();

  const sessions = listWorkspaceSessions({ root, meshHome });
  assert.deepEqual(sessions.map(({ id }) => id), [secondId, firstId]);
  assert.deepEqual(
    sessions.map(({ status, title, preview, messageCount }) => ({
      status,
      title,
      preview,
      messageCount,
    })),
    [
      {
        status: "ok",
        title: "Second session title",
        preview: "Second session title",
        messageCount: 1,
      },
      {
        status: "ok",
        title: "First session title",
        preview: "First session latest message",
        messageCount: 2,
      },
    ],
  );

  const reopenedFirst = MeshWorkspace.open({ root, meshHome, sessionId: firstId });
  assert.deepEqual(
    reopenedFirst.snapshot().messages.map(({ text }) => text),
    ["First session title", "First session latest message"],
  );
  await reopenedFirst.close();
});

test("archiving a registered session hides no Room data", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-archive-session-");
  const workspace = MeshWorkspace.open({ root, meshHome });
  const workspaceId = workspace.workspaceId;
  const sessionId = workspace.sessionId;
  const dataDirectory = workspace.dataDirectory;
  const databasePath = workspace.databasePath;
  await workspace.close();

  archiveRegisteredWorkspaceSession({ workspaceId, sessionId, meshHome });
  archiveRegisteredWorkspaceSession({ workspaceId, sessionId, meshHome });

  const archived = listRegisteredWorkspaceSessions({ workspaceId, meshHome });
  assert.equal(archived[0]?.id, sessionId);
  assert.equal(archived[0]?.archived, true);
  assert.equal(existsSync(dataDirectory), true);
  assert.equal(existsSync(databasePath), true);
  assert.equal(listWorkspaceRegistrations({ meshHome })[0]?.sessionIds.includes(sessionId), true);
});

test("registered session summaries remain readable when the project root is missing", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-missing-root-");
  const workspace = MeshWorkspace.open({ root, meshHome });
  workspace.postText("History outside the project", { idempotencyKey: "missing-root-title" });
  const workspaceId = workspace.workspaceId;
  const sessionId = workspace.sessionId;
  await workspace.close();
  rmdirSync(root);

  const sessions = listRegisteredWorkspaceSessions({ workspaceId, meshHome });
  assert.deepEqual(sessions.map(({ id, status, title }) => ({ id, status, title })), [
    { id: sessionId, status: "ok", title: "History outside the project" },
  ]);
});

test("session listing tolerates and lazily repairs a corrupt derived projection cache", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-projection-repair-");
  const workspace = MeshWorkspace.open({ root, meshHome });
  workspace.postText("Recover this session title", { idempotencyKey: "projection-title" });
  const projectionCachePath = workspace.projectionCachePath;
  const sessionId = workspace.sessionId;
  await workspace.close();

  writeFileSync(projectionCachePath, "{not-json\n", "utf8");
  const fallback = listWorkspaceSessions({ root, meshHome });
  assert.equal(fallback[0]?.id, sessionId);
  assert.equal(fallback[0]?.status, "ok");
  assert.equal(fallback[0]?.title, "New Session");
  assert.equal(fallback[0]?.messageCount, 0);

  const reopened = MeshWorkspace.open({ root, meshHome, sessionId });
  await reopened.close();
  const repaired = listWorkspaceSessions({ root, meshHome });
  assert.equal(repaired[0]?.title, "Recover this session title");
  assert.equal(repaired[0]?.messageCount, 1);
});

test("opening safely migrates legacy project-local config and Room history", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-migration-");
  const legacyDirectory = join(root, ".mesh");
  mkdirSync(legacyDirectory);
  writeFileSync(
    join(legacyDirectory, "config.json"),
    serializeWorkspaceConfig({ ...defaultWorkspaceConfig(), roomId: "room:legacy" }),
    "utf8",
  );
  const legacyStore = new SqliteStore(join(legacyDirectory, "mesh.db"));
  const committed = legacyStore.room("room:legacy").commit({
    id: "legacy-message",
    idempotencyKey: "legacy-message",
    roomId: "room:legacy",
    actorId: "human",
    subject: { kind: "thread", id: "general" },
    action: CoreAction.threadMessageAppend,
    payload: {
      kind: "message",
      text: "preserved through migration",
      attention: "team",
      respondingTo: [],
    },
  });
  assert.equal(committed.status, "committed");
  legacyStore.close();

  const preview = previewWorkspaceConfig({ root, meshHome });
  assert.equal(preview.source, "legacy");
  assert.equal(existsSync(meshHome), false);
  const workspace = MeshWorkspace.open({ root, meshHome, workspaceId: preview.workspaceId });
  assert.equal(workspace.configSource, "file");
  assert.equal(workspace.snapshot().messages[0]?.text, "preserved through migration");
  assert.equal(existsSync(legacyDirectory), false);
  assert.equal(existsSync(workspace.configPath), true);
  assert.equal(existsSync(workspace.databasePath), true);
  await workspace.close();
});

test("opening safely migrates the former centralized workspace directory", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-central-migration-");
  const initial = previewWorkspaceConfig({ root, meshHome });
  const createdAt = "2026-08-16T08:00:00.000Z";
  mkdirSync(meshHome, { recursive: true });
  writeFileSync(
    join(meshHome, "registry.json"),
    `${JSON.stringify({
      version: 1,
      workspaces: [{
        id: initial.workspaceId,
        root,
        name: "project",
        createdAt,
        lastOpenedAt: createdAt,
      }],
    }, undefined, 2)}\n`,
    "utf8",
  );
  const legacyDirectory = join(meshHome, "workspaces", initial.workspaceId);
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    join(legacyDirectory, "config.json"),
    serializeWorkspaceConfig({ ...defaultWorkspaceConfig(), roomId: "room:central-legacy" }),
    "utf8",
  );
  const legacyStore = new SqliteStore(join(legacyDirectory, "mesh.db"));
  legacyStore.room("room:central-legacy").commit({
    id: "central-legacy-message",
    idempotencyKey: "central-legacy-message",
    roomId: "room:central-legacy",
    actorId: "human",
    subject: { kind: "thread", id: "general" },
    action: CoreAction.threadMessageAppend,
    payload: {
      kind: "message",
      text: "preserved from centralized storage",
      attention: "team",
      respondingTo: [],
    },
  });
  legacyStore.close();

  const preview = previewWorkspaceConfig({ root, meshHome });
  assert.equal(preview.workspaceId, initial.workspaceId);
  assert.equal(preview.source, "legacy");
  const workspace = MeshWorkspace.open({
    root,
    meshHome,
    workspaceId: preview.workspaceId,
    sessionId: preview.sessionId,
  });
  assert.equal(workspace.snapshot().messages[0]?.text, "preserved from centralized storage");
  assert.equal(existsSync(legacyDirectory), false);
  assert.equal(existsSync(join(meshHome, "registry.json")), false);
  assert.equal(existsSync(join(meshHome, "storages", "workspace.json")), true);
  assert.equal(existsSync(workspace.headerPath), true);
  await workspace.close();
});

test("workspace preview refuses to merge legacy and centralized histories", async () => {
  const { root, meshHome } = workspaceFixture("mesh-workspace-split-storage-");
  const workspace = MeshWorkspace.open({ root, meshHome });
  await workspace.close();
  const legacyDirectory = join(root, ".mesh");
  mkdirSync(legacyDirectory);
  writeFileSync(
    join(legacyDirectory, "config.json"),
    serializeWorkspaceConfig(defaultWorkspaceConfig()),
    "utf8",
  );

  assert.throws(
    () => previewWorkspaceConfig({ root, meshHome }),
    WorkspaceMigrationConflictError,
  );
});

test("workspace preview rejects a MESH_HOME nested in legacy project data", () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-workspace-overlap-"));
  const root = join(directory, "project");
  const meshHome = join(root, ".mesh");
  mkdirSync(meshHome, { recursive: true });
  writeFileSync(
    join(meshHome, "config.json"),
    serializeWorkspaceConfig(defaultWorkspaceConfig()),
    "utf8",
  );

  assert.throws(
    () => previewWorkspaceConfig({ root, meshHome }),
    WorkspaceStorageOverlapError,
  );
  assert.equal(existsSync(join(meshHome, "registry.json")), false);
});

function workspaceFixture(prefix: string): { readonly root: string; readonly meshHome: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const root = join(directory, "project");
  mkdirSync(root);
  return Object.freeze({ root: realpathSync(root), meshHome: join(directory, "mesh-home") });
}
