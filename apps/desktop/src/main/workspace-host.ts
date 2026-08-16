import type {
  RoomSnapshot,
  WorkspaceConfigPreview,
  WorkspaceConfigSaveInput,
  WorkspaceConfigWriteResult,
} from "@ai-mesh/application";
import { MeshWorkspace, previewWorkspaceConfig, saveWorkspaceConfig } from "@ai-mesh/workspace";

type SnapshotListener = (snapshot: RoomSnapshot) => void;

/**
 * Owns the replaceable workspace composition used by Electron IPC.
 *
 * Desktop requests are serialized around config reloads so no handler can retain
 * or mutate a workspace while it is closing.
 */
export class DesktopWorkspaceHost {
  readonly root: string;
  readonly meshHome: string;
  readonly sessionId: string;

  readonly #listeners = new Set<SnapshotListener>();
  #workspace: MeshWorkspace | undefined;
  #unsubscribeWorkspace: (() => void) | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closing = false;

  private constructor(workspace: MeshWorkspace) {
    this.root = workspace.root;
    this.meshHome = workspace.meshHome;
    this.sessionId = workspace.sessionId;
    this.#install(workspace);
  }

  static open(
    root: string,
    options: {
      readonly meshHome?: string;
      readonly sessionId?: string;
      readonly createSession?: boolean;
    } = {},
  ): DesktopWorkspaceHost {
    return new DesktopWorkspaceHost(MeshWorkspace.open({ root, ...options }));
  }

  run<T>(operation: (workspace: MeshWorkspace) => T | Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop workspace is closing."));
    }
    return this.#enqueue(() => operation(this.#requireWorkspace()));
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
        root: this.root,
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
        this.#install(MeshWorkspace.open({ root: this.root, meshHome: this.meshHome, sessionId: this.sessionId }));
      } catch (reloadError) {
        try {
          saveWorkspaceConfig({
            workspaceId: previous.workspaceId,
            sessionId: previous.sessionId,
            root: this.root,
            meshHome: this.meshHome,
            config: previous.config,
            expectedRevision: written.revision,
          });
          this.#install(MeshWorkspace.open({ root: this.root, meshHome: this.meshHome, sessionId: this.sessionId }));
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
      previewWorkspaceConfig({ root: this.root, meshHome: this.meshHome, sessionId: this.sessionId });
      const active = this.#requireWorkspace();
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
        this.#install(MeshWorkspace.open({ root: this.root, meshHome: this.meshHome, sessionId: this.sessionId }));
      } catch (reloadError) {
        try {
          this.#install(
            MeshWorkspace.open({
              root: this.root,
              meshHome: this.meshHome,
              sessionId: this.sessionId,
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

  close(): Promise<void> {
    if (this.#closing) {
      return this.#tail;
    }
    this.#closing = true;
    return this.#enqueue(async () => {
      const active = this.#workspace;
      this.#detach();
      this.#workspace = undefined;
      await active?.close();
      this.#listeners.clear();
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
    this.#unsubscribeWorkspace = workspace.subscribe((snapshot) => this.#publish(snapshot));
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

  #requireWorkspace(): MeshWorkspace {
    if (this.#workspace === undefined) {
      throw new Error("Desktop workspace is unavailable during configuration reload.");
    }
    return this.#workspace;
  }
}
