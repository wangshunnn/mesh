import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MeshWorkspace,
  WorkspaceConfigConflictError,
  listRegisteredWorkspaceSessions,
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

test("desktop host only archives inactive empty sessions and keeps their local data", async () => {
  const { root, meshHome } = hostFixture("mesh-desktop-host-archive-session-");
  const host = DesktopWorkspaceHost.open(root, { meshHome });
  const first = await host.run((workspace) => {
    workspace.postText("History must survive", { idempotencyKey: "archive-history" });
    return { workspaceId: workspace.workspaceId, sessionId: workspace.sessionId };
  });
  const created = await host.createSession({ workspaceId: first.workspaceId });
  const blankSessionId = created.catalog.activeSessionId;

  await assert.rejects(
    host.archiveSession({ workspaceId: first.workspaceId, sessionId: blankSessionId }),
    /当前会话不能删除/,
  );
  await assert.rejects(
    host.archiveSession(first),
    /仅支持删除没有消息/,
  );

  await host.selectSession(first);
  const catalog = await host.archiveSession({
    workspaceId: first.workspaceId,
    sessionId: blankSessionId,
  });
  assert.equal(catalog.workspaces[0]?.sessions.some(({ id }) => id === blankSessionId), false);
  const coldSession = listRegisteredWorkspaceSessions({
    workspaceId: first.workspaceId,
    meshHome,
  }).find(({ id }) => id === blankSessionId);
  assert.equal(coldSession?.archived, true);
  assert.equal(coldSession?.status, "ok");
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
