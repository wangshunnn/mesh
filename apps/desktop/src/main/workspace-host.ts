import { existsSync } from "node:fs";

import type {
  AgentProbeView,
  RoomSnapshot,
  WorkspaceCatalogView,
  WorkspaceConfigPreview,
  WorkspaceConfigSaveInput,
  WorkspaceConfigWriteResult,
  WorkspaceSelectionView,
} from "@ai-mesh/application";
import type { MessageAttention } from "@ai-mesh/protocol";
import {
  MeshWorkspace,
  type WorkspaceAdapterRegistry,
  archiveRegisteredWorkspace,
  archiveRegisteredWorkspaceSession,
  listRegisteredWorkspaceSessions,
  listWorkspaceRegistrations,
  previewWorkspaceConfig,
  registerWorkspace,
  renameRegisteredWorkspace,
  renameRegisteredWorkspaceSession,
  resolveWorkspaceRoot,
  saveWorkspaceConfig,
} from "@ai-mesh/workspace";

type SnapshotListener = (snapshot: RoomSnapshot) => void;
type CatalogListener = (catalog: WorkspaceCatalogView) => void;

/**
 * Owns the replaceable workspace composition used by Electron IPC.
 *
 * Desktop requests are serialized around config reloads so no handler can retain
 * or mutate a workspace while it is closing.
 */
export class DesktopWorkspaceHost {
  readonly meshHome: string;

  readonly #adapterRegistry: WorkspaceAdapterRegistry | undefined;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #catalogListeners = new Set<CatalogListener>();
  readonly #agentStartTasks = new Set<Promise<unknown>>();
  #workspace: MeshWorkspace | undefined;
  #unsubscribeWorkspace: (() => void) | undefined;
  #catalogTimer: ReturnType<typeof setTimeout> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closing = false;

  private constructor(workspace: MeshWorkspace, adapterRegistry?: WorkspaceAdapterRegistry) {
    this.meshHome = workspace.meshHome;
    this.#adapterRegistry = adapterRegistry;
    this.#install(workspace);
    this.#archiveRedundantBlankSessions();
  }

  static open(
    root: string,
    options: {
      readonly meshHome?: string;
      readonly sessionId?: string;
      readonly createSession?: boolean;
      readonly adapterRegistry?: WorkspaceAdapterRegistry;
    } = {},
  ): DesktopWorkspaceHost {
    return new DesktopWorkspaceHost(MeshWorkspace.open({ root, ...options }), options.adapterRegistry);
  }

  run<T>(operation: (workspace: MeshWorkspace) => T | Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(() => operation(this.#requireWorkspace()));
  }

  catalog(): Promise<WorkspaceCatalogView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(() => this.#catalog());
  }

  probeAgents(): Promise<readonly AgentProbeView[]> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    const active = this.#requireWorkspace();
    return active.probeAgents().then((probes) => {
      if (this.#workspace !== active) {
        throw new Error("Agent probe completed after the active session changed.");
      }
      return Object.freeze(probes.map((probe) => Object.freeze({
        id: probe.id,
        available: probe.availability.available,
        ...(probe.availability.version === undefined ? {} : { version: probe.availability.version }),
        ...(probe.availability.reason === undefined ? {} : { reason: probe.availability.reason }),
      })));
    });
  }

  postMessage(input: { readonly text: string; readonly to?: string }): Promise<RoomSnapshot> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(() => {
      const active = this.#requireWorkspace();
      const attention: MessageAttention | undefined = input.to === undefined
        ? undefined
        : input.to === "team"
          ? "team"
          : [active.resolveParticipant(input.to)];
      const event = active.postText(input.text, {
        ...(attention === undefined ? {} : { attention }),
      });
      const snapshot = active.snapshot();
      this.#scheduleAgentStart(active, event.payload.attention);
      return snapshot;
    });
  }

  openWorkspace(input: { readonly root: string }): Promise<WorkspaceSelectionView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      const root = resolveWorkspaceRoot(input.root);
      const active = this.#requireWorkspace();
      if (active.root === root) {
        if (!listWorkspaceRegistrations({ meshHome: this.meshHome }).some(({ id }) => id === active.workspaceId)) {
          registerWorkspace({
            root,
            meshHome: this.meshHome,
            workspaceId: active.workspaceId,
            sessionId: active.sessionId,
          });
          const selection = this.#selection();
          this.#publishCatalog(selection.catalog);
          return selection;
        }
        return this.#selection();
      }
      return this.#replaceWorkspace(active, { root, meshHome: this.meshHome });
    });
  }

  createSession(input: { readonly workspaceId: string }): Promise<WorkspaceSelectionView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      const registration = this.#registration(input.workspaceId);
      this.#assertRootAvailable(registration.root);
      const active = this.#requireWorkspace();
      const blankSession = listRegisteredWorkspaceSessions({
        workspaceId: registration.id,
        meshHome: this.meshHome,
      }).find((session) => session.status === "ok"
        && !session.archived
        && (active.workspaceId === registration.id && active.sessionId === session.id
          ? active.snapshot().messages.length === 0
          : session.messageCount === 0));
      if (blankSession !== undefined) {
        if (active.workspaceId === registration.id && active.sessionId === blankSession.id) {
          return this.#selection();
        }
        return this.#replaceWorkspace(active, {
          root: registration.root,
          meshHome: this.meshHome,
          sessionId: blankSession.id,
        });
      }
      return this.#replaceWorkspace(active, {
        root: registration.root,
        meshHome: this.meshHome,
        createSession: true,
      });
    });
  }

  selectSession(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }): Promise<WorkspaceSelectionView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      const registration = this.#registration(input.workspaceId);
      this.#assertRootAvailable(registration.root);
      const session = listRegisteredWorkspaceSessions({
        workspaceId: registration.id,
        meshHome: this.meshHome,
      }).find((candidate) => candidate.id === input.sessionId);
      if (session === undefined) {
        throw new Error(`Unknown Mesh session ${input.sessionId} for workspace ${registration.id}.`);
      }
      if (session.status !== "ok") {
        throw new Error(`Cannot open ${session.title}: ${session.detail ?? `session is ${session.status}`}.`);
      }
      const active = this.#requireWorkspace();
      if (active.workspaceId === registration.id && active.sessionId === session.id) {
        return this.#selection();
      }
      return this.#replaceWorkspace(active, {
        root: registration.root,
        meshHome: this.meshHome,
        sessionId: session.id,
      });
    });
  }

  renameSession(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly title: string;
  }): Promise<WorkspaceCatalogView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(() => {
      const session = listRegisteredWorkspaceSessions({
        workspaceId: input.workspaceId,
        meshHome: this.meshHome,
      }).find((candidate) => candidate.id === input.sessionId && !candidate.archived);
      if (session === undefined || session.status !== "ok") {
        throw new Error(`Unknown or unavailable Mesh session ${input.sessionId}.`);
      }
      renameRegisteredWorkspaceSession({ ...input, meshHome: this.meshHome });
      const catalog = this.#catalog();
      this.#publishCatalog(catalog);
      return catalog;
    });
  }

  archiveSession(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
  }): Promise<WorkspaceSelectionView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      const active = this.#requireWorkspace();
      const session = listRegisteredWorkspaceSessions({
        workspaceId: input.workspaceId,
        meshHome: this.meshHome,
      }).find((candidate) => candidate.id === input.sessionId);
      if (session === undefined || session.archived) {
        throw new Error(`Unknown Mesh session ${input.sessionId} for workspace ${input.workspaceId}.`);
      }
      if (session.status !== "ok") {
        throw new Error("不可用的会话无法归档。");
      }
      if (active.workspaceId === input.workspaceId && active.sessionId === input.sessionId) {
        const registration = this.#registration(input.workspaceId);
        const replacement = listRegisteredWorkspaceSessions({
          workspaceId: input.workspaceId,
          meshHome: this.meshHome,
        }).find((candidate) =>
          candidate.id !== input.sessionId && !candidate.archived && candidate.status === "ok");
        await this.#replaceWorkspace(active, {
          root: registration.root,
          meshHome: this.meshHome,
          ...(replacement === undefined ? { createSession: true } : { sessionId: replacement.id }),
        });
      }
      archiveRegisteredWorkspaceSession({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        meshHome: this.meshHome,
      });
      const selection = this.#selection();
      this.#publishCatalog(selection.catalog);
      return selection;
    });
  }

  renameWorkspace(input: {
    readonly workspaceId: string;
    readonly name: string;
  }): Promise<WorkspaceCatalogView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(() => {
      renameRegisteredWorkspace({ ...input, meshHome: this.meshHome });
      const catalog = this.#catalog();
      this.#publishCatalog(catalog);
      return catalog;
    });
  }

  removeWorkspace(input: {
    readonly workspaceId: string;
  }): Promise<WorkspaceSelectionView> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      const active = this.#requireWorkspace();
      this.#registration(input.workspaceId);
      if (active.workspaceId === input.workspaceId) {
        const fallback = listWorkspaceRegistrations({ meshHome: this.meshHome })
          .filter((workspace) => workspace.id !== input.workspaceId && existsSync(workspace.root))
          .map((workspace) => ({
            workspace,
            session: listRegisteredWorkspaceSessions({
              workspaceId: workspace.id,
              meshHome: this.meshHome,
            }).find((session) => !session.archived && session.status === "ok"),
          }))
          .find(({ session }) => session !== undefined);
        if (fallback?.session !== undefined) {
          await this.#replaceWorkspace(active, {
            root: fallback.workspace.root,
            meshHome: this.meshHome,
            sessionId: fallback.session.id,
          });
        }
      }
      archiveRegisteredWorkspace({ workspaceId: input.workspaceId, meshHome: this.meshHome });
      const selection = this.#selection();
      this.#publishCatalog(selection.catalog);
      return selection;
    });
  }

  saveConfig(input: WorkspaceConfigSaveInput): Promise<WorkspaceConfigWriteResult> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      const active = this.#requireWorkspace();
      const previous = active.configPreview();
      const written = saveWorkspaceConfig({
        workspaceId: previous.workspaceId,
        sessionId: previous.sessionId,
        root: active.root,
        meshHome: this.meshHome,
        config: input.config,
        expectedRevision: input.expectedRevision,
      });
      if (!written.changed) {
        return written;
      }

      this.#detach();
      this.#workspace = undefined;
      let closeError: unknown;
      try {
        await active.close();
      } catch (error) {
        closeError = error;
      }
      try {
        this.#install(this.#open({ root: active.root, meshHome: this.meshHome, sessionId: active.sessionId }));
      } catch (reloadError) {
        try {
          saveWorkspaceConfig({
            workspaceId: previous.workspaceId,
            sessionId: previous.sessionId,
            root: active.root,
            meshHome: this.meshHome,
            config: previous.config,
            expectedRevision: written.revision,
          });
          this.#install(this.#open({ root: active.root, meshHome: this.meshHome, sessionId: active.sessionId }));
        } catch (recoveryError) {
          throw new AggregateError(
            [reloadError, recoveryError],
            "Could not reload the saved workspace configuration or restore the previous one.",
          );
        }
        throw new Error(
          "Could not reload the saved workspace configuration. The previous configuration was restored.",
          { cause: reloadError },
        );
      }

      this.#publish(this.#requireWorkspace().snapshot());
      this.#publishCatalog(this.#catalog());
      if (closeError !== undefined) {
        throw new Error(
          "The configuration was saved and reloaded, but the previous workspace did not close cleanly.",
          { cause: closeError },
        );
      }
      return written;
    });
  }

  reloadConfig(): Promise<WorkspaceConfigPreview> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(async () => {
      // Validate the current file before giving up the known-good live composition.
      const active = this.#requireWorkspace();
      previewWorkspaceConfig({ root: active.root, meshHome: this.meshHome, sessionId: active.sessionId });
      const previous = active.configPreview();
      this.#detach();
      this.#workspace = undefined;
      let closeError: unknown;
      try {
        await active.close();
      } catch (error) {
        closeError = error;
      }
      try {
        this.#install(this.#open({ root: active.root, meshHome: this.meshHome, sessionId: active.sessionId }));
      } catch (reloadError) {
        try {
          this.#install(
            this.#open({
              root: active.root,
              meshHome: this.meshHome,
              sessionId: active.sessionId,
              config: previous.config,
              persistDefaultConfig: false,
            }),
          );
        } catch (recoveryError) {
          throw new AggregateError(
            [reloadError, recoveryError],
            "Could not reload workspace configuration or restore the previous live configuration.",
          );
        }
        throw new Error(
          "Could not reload workspace configuration. The previous configuration remains active.",
          { cause: reloadError },
        );
      }
      const workspace = this.#requireWorkspace();
      this.#publish(workspace.snapshot());
      this.#publishCatalog(this.#catalog());
      if (closeError !== undefined) {
        throw new Error(
          "The disk configuration was reloaded, but the previous workspace did not close cleanly.",
          { cause: closeError },
        );
      }
      return workspace.configPreview();
    });
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeCatalog(listener: CatalogListener): () => void {
    this.#catalogListeners.add(listener);
    return () => this.#catalogListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.#closing) {
      return this.#tail;
    }
    this.#closing = true;
    return this.#enqueue(async () => {
      const active = this.#workspace;
      if (this.#catalogTimer !== undefined) clearTimeout(this.#catalogTimer);
      this.#catalogTimer = undefined;
      this.#detach();
      this.#workspace = undefined;
      await active?.close();
      await Promise.allSettled([...this.#agentStartTasks]);
      this.#listeners.clear();
      this.#catalogListeners.clear();
    });
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #install(workspace: MeshWorkspace): void {
    this.#workspace = workspace;
    this.#unsubscribeWorkspace = workspace.subscribe((snapshot) => {
      this.#publish(snapshot);
      this.#scheduleCatalogPublish();
    });
  }

  #detach(): void {
    this.#unsubscribeWorkspace?.();
    this.#unsubscribeWorkspace = undefined;
  }

  #publish(snapshot: RoomSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("Desktop workspace snapshot listener failed:", error);
      }
    }
  }

  #publishCatalog(catalog: WorkspaceCatalogView): void {
    for (const listener of this.#catalogListeners) {
      try {
        listener(catalog);
      } catch (error) {
        console.error("Desktop workspace catalog listener failed:", error);
      }
    }
  }

  #scheduleCatalogPublish(): void {
    if (this.#catalogTimer !== undefined || this.#closing) return;
    this.#catalogTimer = setTimeout(() => {
      this.#catalogTimer = undefined;
      if (!this.#closing && this.#workspace !== undefined) this.#publishCatalog(this.#catalog());
    }, 80);
    this.#catalogTimer.unref?.();
  }

  #scheduleAgentStart(workspace: MeshWorkspace, attention: MessageAttention): void {
    const task = workspace.startAgentsForAttention(attention);
    this.#agentStartTasks.add(task);
    void task.finally(() => this.#agentStartTasks.delete(task));
  }

  #archiveRedundantBlankSessions(): void {
    const active = this.#requireWorkspace();
    const activeIsBlank = active.snapshot().messages.length === 0;
    for (const registration of listWorkspaceRegistrations({ meshHome: this.meshHome })) {
      const blankSessions = listRegisteredWorkspaceSessions({
        workspaceId: registration.id,
        meshHome: this.meshHome,
      }).filter((session) => session.status === "ok"
        && !session.archived
        && (registration.id === active.workspaceId && session.id === active.sessionId
          ? activeIsBlank
          : session.messageCount === 0));
      if (blankSessions.length < 2) continue;
      const keeper = blankSessions.find((session) => registration.id === active.workspaceId
        && session.id === active.sessionId) ?? blankSessions[0];
      for (const session of blankSessions) {
        if (session.id === keeper?.id) continue;
        archiveRegisteredWorkspaceSession({
          workspaceId: registration.id,
          sessionId: session.id,
          meshHome: this.meshHome,
        });
      }
    }
  }

  #catalog(): WorkspaceCatalogView {
    const active = this.#requireWorkspace();
    return Object.freeze({
      activeWorkspaceId: active.workspaceId,
      activeSessionId: active.sessionId,
      workspaces: Object.freeze(listWorkspaceRegistrations({ meshHome: this.meshHome }).map((workspace) => {
        const available = existsSync(workspace.root);
        return Object.freeze({
          id: workspace.id,
          name: workspace.name,
          root: workspace.root,
          status: available ? "available" as const : "missing" as const,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          lastOpenedAt: workspace.lastOpenedAt,
          sessions: Object.freeze(listRegisteredWorkspaceSessions({
            workspaceId: workspace.id,
            meshHome: this.meshHome,
          }).filter((session) => !session.archived).map((session) => Object.freeze({
            id: session.id,
            workspaceId: session.workspaceId,
            status: session.status,
            title: session.title,
            preview: session.preview,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            headSequence: session.headSequence,
            messageCount: session.messageCount,
            archived: session.archived,
            ...(session.detail === undefined ? {} : { detail: session.detail }),
          }))),
          ...(available ? {} : { detail: "Project directory is missing or unavailable." }),
        });
      })),
    });
  }

  #selection(): WorkspaceSelectionView {
    const workspace = this.#requireWorkspace();
    return Object.freeze({
      catalog: this.#catalog(),
      snapshot: workspace.snapshot(),
      configPreview: workspace.configPreview(),
    });
  }

  async #replaceWorkspace(
    active: MeshWorkspace,
    options: Parameters<typeof MeshWorkspace.open>[0],
  ): Promise<WorkspaceSelectionView> {
    const previous = Object.freeze({
      root: active.root,
      meshHome: active.meshHome,
      sessionId: active.sessionId,
    });
    this.#detach();
    this.#workspace = undefined;
    let closeError: unknown;
    try {
      await active.close();
    } catch (error) {
      closeError = error;
    }

    try {
      this.#install(this.#open(options));
    } catch (openError) {
      try {
        this.#install(this.#open(previous));
      } catch (recoveryError) {
        throw new AggregateError(
          [openError, recoveryError],
          "Could not open the selected workspace session or restore the previous session.",
        );
      }
      throw new Error(
        "Could not open the selected workspace session. The previous session remains active.",
        { cause: openError },
      );
    }

    const selection = this.#selection();
    this.#publish(selection.snapshot);
    this.#publishCatalog(selection.catalog);
    if (closeError !== undefined) {
      throw new Error(
        "The selected workspace session opened, but the previous session did not close cleanly.",
        { cause: closeError },
      );
    }
    return selection;
  }

  #registration(workspaceId: string) {
    const registration = listWorkspaceRegistrations({ meshHome: this.meshHome })
      .find((workspace) => workspace.id === workspaceId);
    if (registration === undefined) throw new Error(`Unknown Mesh workspace ${workspaceId}.`);
    return registration;
  }

  #assertRootAvailable(root: string): void {
    if (!existsSync(root)) throw new Error(`Project directory is missing or unavailable: ${root}`);
  }

  #open(options: Parameters<typeof MeshWorkspace.open>[0]): MeshWorkspace {
    return MeshWorkspace.open({
      ...options,
      ...(this.#adapterRegistry === undefined ? {} : { adapterRegistry: this.#adapterRegistry }),
    });
  }

  #requireWorkspace(): MeshWorkspace {
    if (this.#workspace === undefined) {
      throw new Error("Desktop workspace is unavailable during configuration reload.");
    }
    return this.#workspace;
  }
}
