import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceConfigConflictError, saveWorkspaceConfig } from "@ai-mesh/workspace";

import { DesktopWorkspaceHost } from "./workspace-host.js";

test("desktop host reloads a changed config and keeps IPC operations on the new workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-desktop-host-"));
  const host = DesktopWorkspaceHost.open(root);
  const updates: string[] = [];
  const unsubscribe = host.subscribe((snapshot) => updates.push(snapshot.roomId));
  const preview = await host.run((workspace) => workspace.configPreview());

  const saved = await host.saveConfig({
    expectedRevision: preview.revision,
    config: { ...preview.config, roomId: "room:desktop-reloaded" },
  });

  assert.equal(saved.changed, true);
  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:desktop-reloaded");
  assert.deepEqual(updates, ["room:desktop-reloaded"]);
  unsubscribe();
  await host.close();
});

test("desktop host rejects a stale save without losing the active workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-desktop-host-stale-"));
  const host = DesktopWorkspaceHost.open(root);
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
  const root = mkdtempSync(join(tmpdir(), "mesh-desktop-host-reload-"));
  const host = DesktopWorkspaceHost.open(root);
  const preview = await host.run((workspace) => workspace.configPreview());
  saveWorkspaceConfig({
    root,
    expectedRevision: preview.revision,
    config: { ...preview.config, roomId: "room:external-save" },
  });

  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:main");
  const reloaded = await host.reloadConfig();
  assert.equal(reloaded.config.roomId, "room:external-save");
  assert.equal(await host.run((workspace) => workspace.snapshot().roomId), "room:external-save");
  await host.close();
});
