import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MeshWorkspace,
  WorkspaceAdapterRegistry,
  WorkspaceConfigConflictError,
  listRegisteredWorkspaceSessions,
  listWorkspaceRegistrations,
  saveWorkspaceConfig,
} from "@ai-mesh/workspace";

import { DesktopWorkspaceHost } from "./workspace-host.js";

test("desktop host reloads a changed config and keeps IPC operations on the new workspace", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const updates: string[] = [];
  const unsubscribe = host.subscribe((snapshot) => updates.push(snapshot.roomId));
  const preview = await host.run((workspace) => workspace.configPreview());

  const saved = await host.saveConfig({
    expectedRevision: preview.revision,
    config: { ...preview.config, roomId: "room:desktop-reloaded" },
  });

  assert.equal(saved.changed, true);
  assert.equal((await host.run((workspace) => workspace.sessionId)), preview.sessionId);
  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:desktop-reloaded");
  assert.deepEqual(updates, ["room:desktop-reloaded"]);
  unsubscribe();
  await host.close();
});

test("desktop host rejects a stale save without losing the active workspace", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-stale-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const preview = await host.run((workspace) => workspace.configPreview());
  const saved = await host.saveConfig({
    expectedRevision: preview.revision,
    config: { ...preview.config, roomId: "room:first-save" },
  });

  await assert.rejects(
    host.saveConfig({
      expectedRevision: preview.revision,
      config: { ...preview.config, roomId: "room:stale-save" },
    }),
    WorkspaceConfigConflictError,
  );
  assert.equal(saved.changed, true);
  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:first-save");
  await host.close();
});

test("desktop host explicitly reloads a newer config written by another client", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-reload-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const preview = await host.run((workspace) => workspace.configPreview());
  saveWorkspaceConfig({
    workspaceId: preview.workspaceId,
    sessionId: preview.sessionId,
    root,
    meshHome,
    expectedRevision: preview.revision,
    config: { ...preview.config, roomId: "room:external-save" },
  });

  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:main");
  const reloaded = await host.reloadConfig();
  assert.equal(reloaded.config.roomId, "room:external-save");
  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:external-save");
  await host.close();
});

test("desktop host creates and switches isolated sessions without reordering history", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-sessions-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const first = await host.run((workspace) => {
    workspace.postText("First Room history", { idempotencyKey: "first-room-history" });
    return { workspaceId: workspace.workspaceId, sessionId: workspace.sessionId };
  });

  const created = await host.createSession({ workspaceId: first.workspaceId });
  const secondId = created.catalog.activeSessionId;
  assert.notEqual(secondId, first.sessionId);
  assert.deepEqual(
    created.catalog.workspaces[0]?.sessions.map(({ id }) => id),
    [secondId, first.sessionId],
  );
  assert.deepEqual(created.snapshot.messages, []);
  await host.run((workspace) => {
    workspace.postText("Second Room history", { idempotencyKey: "second-room-history" });
  });

  const selected = await host.selectSession({
    workspaceId: first.workspaceId,
    sessionId: first.sessionId,
  });
  assert.deepEqual(selected.snapshot.messages.map(({ text }) => text), ["First Room history"]);
  assert.deepEqual(
    selected.catalog.workspaces[0]?.sessions.map(({ id }) => id),
    [secondId, first.sessionId],
  );
  await host.close();
});

test("desktop host keeps sessions cold and starts only Agents addressed by Human messages", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-lazy-agents-");
  const starts = new Map<string, number>();
  const host = DesktopWorkspaceHost.open(root, {
    meshHome,
    adapterRegistry: trackingAdapterRegistry(starts),
  });

  assert.deepEqual(
    (await host.run((workspace) => workspace.snapshot())).agents.map((agent) => agent.state),
    ["offline", "offline"],
  );
  await host.postMessage({ text: "@codex only you" });
  await waitFor(() => starts.get("agent:codex") === 1);
  assert.equal(starts.get("agent:opencode") ?? 0, 0);

  await host.postMessage({ text: "Everyone can see this", to: "team" });
  await waitFor(() => starts.get("agent:opencode") === 1);
  assert.equal(starts.get("agent:codex"), 1);

  const workspaceId = await host.run((workspace) => workspace.workspaceId);
  const created = await host.createSession({ workspaceId });
  assert.deepEqual(created.snapshot.messages, []);
  assert.equal(starts.get("agent:opencode"), 1);
  assert.equal(starts.get("agent:codex"), 1);
  assert.deepEqual(created.snapshot.agents.map((agent) => agent.state), ["offline", "offline"]);
  await host.close();
});

test("an asynchronous Agent probe does not serialize session navigation", { timeout: 2_000 }, async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-probe-navigation-");
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const host = DesktopWorkspaceHost.open(root, {
    meshHome,
    adapterRegistry: gatedProbeAdapterRegistry(probeGate),
  });
  const workspaceId = await host.run((workspace) => {
    workspace.postText("Create another session", { idempotencyKey: "probe-navigation-history" });
    return workspace.workspaceId;
  });

  const probing = host.probeAgents();
  const created = await host.createSession({ workspaceId });
  assert.deepEqual(created.snapshot.messages, []);
  releaseProbe?.();
  await assert.rejects(probing, /active session changed/);
  await host.close();
});

test("desktop host reuses the workspace's single blank session", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-blank-session-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const initial = await host.catalog();
  const workspaceId = initial.activeWorkspaceId;
  const initialSessionId = initial.activeSessionId;
  assert.ok(workspaceId);
  assert.ok(initialSessionId);

  const reusedInitial = await host.createSession({ workspaceId });
  assert.equal(reusedInitial.catalog.activeSessionId, initialSessionId);
  assert.equal(reusedInitial.catalog.workspaces[0]?.sessions.length, 1);

  await host.run((workspace) => {
    workspace.postText("Committed history", { idempotencyKey: "blank-session-history" });
  });
  const created = await host.createSession({ workspaceId });
  const blankSessionId = created.catalog.activeSessionId;
  assert.notEqual(blankSessionId, initialSessionId);

  const reusedCreated = await host.createSession({ workspaceId });
  assert.equal(reusedCreated.catalog.activeSessionId, blankSessionId);
  assert.deepEqual(
    reusedCreated.catalog.workspaces[0]?.sessions.map(({ id }) => id),
    [blankSessionId, initialSessionId],
  );
  await host.close();
});

test("desktop host archives redundant historical blanks on startup", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-old-blank-sessions-");
  const first = MeshWorkspace.open({ root, meshHome });
  const workspaceId = first.workspaceId;
  const firstId = first.sessionId;
  const firstDatabase = first.databasePath;
  await first.close();
  const second = MeshWorkspace.open({ root, meshHome, createSession: true });
  const secondId = second.sessionId;
  const secondDatabase = second.databasePath;
  await second.close();
  const newest = MeshWorkspace.open({ root, meshHome, createSession: true });
  const newestId = newest.sessionId;
  await newest.close();

  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const catalog = await host.catalog();
  assert.deepEqual(catalog.workspaces[0]?.sessions.map(({ id }) => id), [newestId]);
  assert.equal(catalog.activeSessionId, newestId);
  const cold = listRegisteredWorkspaceSessions({ workspaceId, meshHome });
  assert.deepEqual(
    cold.filter(({ archived }) => archived).map(({ id }) => id),
    [secondId, firstId],
  );
  assert.equal(existsSync(firstDatabase), true);
  assert.equal(existsSync(secondDatabase), true);
  await host.close();
});

test("desktop host archives active sessions through a safe replacement and keeps their local data", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-archive-session-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const first = await host.run((workspace) => {
    workspace.postText("History must survive", { idempotencyKey: "archive-history" });
    return { workspaceId: workspace.workspaceId, sessionId: workspace.sessionId };
  });
  const created = await host.createSession({ workspaceId: first.workspaceId });
  const blankSessionId = created.catalog.activeSessionId;

  const afterBlank = await host.archiveSession({
    workspaceId: first.workspaceId,
    sessionId: blankSessionId,
  });
  assert.equal(afterBlank.catalog.activeSessionId, first.sessionId);
  assert.equal(afterBlank.catalog.workspaces[0]?.sessions.some(({ id }) => id === blankSessionId), false);

  const afterHistory = await host.archiveSession(first);
  assert.notEqual(afterHistory.catalog.activeSessionId, first.sessionId);
  assert.equal(afterHistory.snapshot.messages.length, 0);
  assert.equal(afterHistory.catalog.workspaces[0]?.sessions.some(({ id }) => id === first.sessionId), false);
  const coldSessions = listRegisteredWorkspaceSessions({
    workspaceId: first.workspaceId,
    meshHome,
  });
  assert.equal(coldSessions.find(({ id }) => id === blankSessionId)?.archived, true);
  assert.equal(coldSessions.find(({ id }) => id === first.sessionId)?.archived, true);
  await host.close();
});

test("desktop host renames sessions, then removes and restores workspace registrations", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-sidebar-actions-");
  const secondRoot = join(root, "..", "sidebar-actions-second");
  mkdirSync(secondRoot);
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const source = await host.run((workspace) => {
    workspace.postText("Pinned history", { idempotencyKey: "pinned-history" });
    return { workspaceId: workspace.workspaceId, sessionId: workspace.sessionId };
  });

  const renamedCatalog = await host.renameSession({ ...source, title: "Pinned title" });
  assert.equal(renamedCatalog.workspaces[0]?.sessions[0]?.title, "Pinned title");
  assert.deepEqual(await host.run((workspace) => workspace.snapshot().messages.map(({ text }) => text)), ["Pinned history"]);

  const opened = await host.openWorkspace({ root: secondRoot });
  const secondWorkspaceId = opened.catalog.activeWorkspaceId;
  const renamedWorkspace = await host.renameWorkspace({
    workspaceId: secondWorkspaceId,
    name: "Second workspace",
  });
  assert.equal(renamedWorkspace.workspaces[0]?.name, "Second workspace");

  const removed = await host.removeWorkspace({ workspaceId: secondWorkspaceId });
  assert.equal(removed.catalog.activeWorkspaceId, source.workspaceId);
  assert.equal(removed.catalog.workspaces.some(({ id }) => id === secondWorkspaceId), false);
  assert.equal(listWorkspaceRegistrations({ meshHome }).length, 1);
  assert.equal(listWorkspaceRegistrations({ meshHome, includeArchived: true }).length, 2);

  const restored = await host.openWorkspace({ root: secondRoot });
  assert.equal(restored.catalog.activeWorkspaceId, secondWorkspaceId);
  assert.equal(restored.catalog.workspaces.find(({ id }) => id === secondWorkspaceId)?.name, "Second workspace");
  await host.close();
});

test("desktop host removes the sole active registration while keeping its live Room recoverable", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-remove-only-workspace-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const current = await host.run((workspace) => {
    workspace.postText("Still live after removal", { idempotencyKey: "live-after-removal" });
    return { workspaceId: workspace.workspaceId, sessionId: workspace.sessionId };
  });

  const removed = await host.removeWorkspace({ workspaceId: current.workspaceId });
  assert.equal(removed.catalog.workspaces.length, 0);
  assert.equal(removed.catalog.activeWorkspaceId, current.workspaceId);
  assert.deepEqual(removed.snapshot.messages.map(({ text }) => text), ["Still live after removal"]);
  assert.equal(listWorkspaceRegistrations({ meshHome }).length, 0);

  const restored = await host.openWorkspace({ root });
  assert.equal(restored.catalog.workspaces.length, 1);
  assert.equal(restored.catalog.activeWorkspaceId, current.workspaceId);
  assert.equal(restored.catalog.activeSessionId, current.sessionId);
  await host.close();
});

test("desktop host opens another project and can return to the original session", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-projects-");
  const secondRoot = join(root, "..", "another-project");
  mkdirSync(secondRoot);
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const first = await host.run((workspace) => ({
    workspaceId: workspace.workspaceId,
    sessionId: workspace.sessionId,
  }));

  const opened = await host.openWorkspace({ root: secondRoot });
  assert.equal(opened.catalog.workspaces.length, 2);
  assert.notEqual(opened.catalog.activeWorkspaceId, first.workspaceId);
  assert.deepEqual(opened.snapshot.messages, []);

  const returned = await host.selectSession(first);
  assert.equal(returned.catalog.activeWorkspaceId, first.workspaceId);
  assert.equal(returned.catalog.activeSessionId, first.sessionId);
  assert.equal(returned.catalog.workspaces.length, 2);
  await host.close();
});

test("desktop host reports corrupt sessions and keeps the active session when selection fails", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-corrupt-session-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const first = await host.run((workspace) => ({
    workspaceId: workspace.workspaceId,
    sessionId: workspace.sessionId,
    headerPath: workspace.headerPath,
  }));
  const created = await host.createSession({ workspaceId: first.workspaceId });
  const activeSessionId = created.catalog.activeSessionId;
  writeFileSync(first.headerPath, "{not-json\n", "utf8");

  const catalog = await host.catalog();
  const corrupt = catalog.workspaces[0]?.sessions.find(({ id }) => id === first.sessionId);
  assert.equal(corrupt?.status, "corrupt");
  await assert.rejects(
    host.selectSession({ workspaceId: first.workspaceId, sessionId: first.sessionId }),
    /Cannot open/,
  );
  assert.equal(await host.run((workspace) => workspace.sessionId), activeSessionId);
  await host.close();
});

function hostFixture(prefix: string): { readonly root: string; readonly meshHome: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const root = join(directory, "project");
  mkdirSync(root);
  return Object.freeze({ root, meshHome: join(directory, "mesh-home") });
}

function trackingAdapterRegistry(starts: Map<string, number>): WorkspaceAdapterRegistry {
  return new WorkspaceAdapterRegistry([
    Object.freeze({
      kind: "opencode-acp" as const,
      create: () => trackingAdapter("tracking-opencode", starts),
    }),
    Object.freeze({
      kind: "codex-native" as const,
      create: () => trackingAdapter("tracking-codex", starts),
    }),
  ]);
}

function gatedProbeAdapterRegistry(gate: Promise<void>): WorkspaceAdapterRegistry {
  return new WorkspaceAdapterRegistry([
    Object.freeze({
      kind: "opencode-acp" as const,
      create: () => gatedProbeAdapter("gated-opencode", gate),
    }),
    Object.freeze({
      kind: "codex-native" as const,
      create: () => gatedProbeAdapter("gated-codex", gate),
    }),
  ]);
}

function trackingAdapter(
  kind: string,
  starts: Map<string, number>,
): ReturnType<WorkspaceAdapterRegistry["create"]> {
  const adapter = gatedProbeAdapter(kind, Promise.resolve());
  return Object.freeze({
    ...adapter,
    start: async (config: Parameters<typeof adapter.start>[0]) => {
      starts.set(config.agentId, (starts.get(config.agentId) ?? 0) + 1);
      return adapter.start(config);
    },
  });
}

function gatedProbeAdapter(
  kind: string,
  gate: Promise<void>,
): ReturnType<WorkspaceAdapterRegistry["create"]> {
  type Adapter = ReturnType<WorkspaceAdapterRegistry["create"]>;
  type Session = Awaited<ReturnType<Adapter["start"]>>;
  const capabilities = Object.freeze({
    persistentSession: true,
    streaming: false,
    cancel: true,
    loadSession: true,
    transport: "scripted" as const,
  });
  return Object.freeze({
    kind,
    capabilities,
    probe: async () => {
      await gate;
      return Object.freeze({ available: true, command: kind, version: "test" });
    },
    start: async (config: Parameters<Adapter["start"]>[0]) => Object.freeze({
      id: config.sessionId ?? `${kind}:${config.agentId}`,
      agentId: config.agentId,
      capabilities,
      status: "ready" as const,
      prompt: async (input: Parameters<Session["prompt"]>[0]) => Object.freeze({
        turnId: input.turnId,
        text: "",
        stopReason: "completed" as const,
      }),
      cancel: async () => undefined,
      events: async function* () {
        return;
      },
      stop: async () => undefined,
    }),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition did not become true.");
}
