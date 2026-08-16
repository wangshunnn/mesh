import { mkdirSync } from "node:fs";

import type {
  RoomSnapshot,
  WorkspaceConfig,
  WorkspaceConfigPreview,
  WorkspaceConfigSource,
} from "@ai-mesh/application";
import type { AgentAdapter, AgentAvailability } from "@ai-mesh/agent";
import {
  CollaborationRuntime,
  type CreateTaskInput,
  type PostMessageInput,
  type SnapshotListener,
  type UpdateTaskInput,
} from "@ai-mesh/collaboration";
import type {
  CommitResult,
  MessageAttention,
  ParticipantId,
  RoomEvent,
  RoomMessagePayload,
  TaskClaimedPayload,
  TaskCreatedPayload,
  TaskUpdatedPayload,
} from "@ai-mesh/protocol";
import type { Unsubscribe } from "@ai-mesh/room";
import { SqliteStore } from "@ai-mesh/store-sqlite";

import {
  createBuiltinWorkspaceAdapterRegistry,
  type WorkspaceAdapterRegistry,
} from "./adapters.js";
import {
  previewWorkspaceConfig,
  saveWorkspaceConfig,
  type WorkspaceConfigInput,
} from "./config.js";
import {
  createWorkspaceSessionId,
  inspectWorkspaceStorage,
  prepareWorkspaceStorage,
  recordWorkspaceSessionProjection,
  type WorkspaceStorageLocation,
} from "./storage.js";

export interface OpenWorkspaceOptions extends WorkspaceConfigInput {
  readonly persistDefaultConfig?: boolean;
  readonly adapterRegistry?: WorkspaceAdapterRegistry;
  /** Create a new session instead of selecting the workspace's newest session. */
  readonly createSession?: boolean;
}

export interface AgentProbeResult {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapter: WorkspaceConfig["agents"][number]["adapter"];
  readonly availability: AgentAvailability;
}

export interface StartAvailableAgentsResult {
  readonly started: readonly ParticipantId[];
  readonly unavailable: readonly AgentProbeResult[];
  readonly failed: readonly {
    readonly agentId: ParticipantId;
    readonly message: string;
  }[];
}

/** Local composition root shared by the headless CLI and Electron main process. */
export class MeshWorkspace {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly meshHome: string;
  readonly projectKey: string;
  readonly registryPath: string;
  readonly projectionCachePath: string;
  readonly sessionDirectory: string;
  readonly headerPath: string;
  readonly dataDirectory: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly configSource: WorkspaceConfigSource;
  readonly configRevision: string | null;
  readonly config: WorkspaceConfig;
  readonly runtime: CollaborationRuntime;

  readonly #store: SqliteStore;
  readonly #storage: WorkspaceStorageLocation;
  readonly #adapters = new Map<ParticipantId, AgentAdapter>();
  #projectionTimer: ReturnType<typeof setTimeout> | undefined;
  #projectionUnsubscribe: Unsubscribe | undefined;
  #closed = false;

  private constructor(
    workspaceId: string,
    sessionId: string,
    root: string,
    meshHome: string,
    projectKey: string,
    registryPath: string,
    projectionCachePath: string,
    sessionDirectory: string,
    headerPath: string,
    dataDirectory: string,
    configPath: string,
    databasePath: string,
    configSource: WorkspaceConfigSource,
    configRevision: string | null,
    config: WorkspaceConfig,
    store: SqliteStore,
    runtime: CollaborationRuntime,
    storage: WorkspaceStorageLocation,
  ) {
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.root = root;
    this.meshHome = meshHome;
    this.projectKey = projectKey;
    this.registryPath = registryPath;
    this.projectionCachePath = projectionCachePath;
    this.sessionDirectory = sessionDirectory;
    this.headerPath = headerPath;
    this.dataDirectory = dataDirectory;
    this.configPath = configPath;
    this.databasePath = databasePath;
    this.configSource = configSource;
    this.configRevision = configRevision;
    this.config = config;
    this.#store = store;
    this.#storage = storage;
    this.runtime = runtime;
  }

  static open(options: OpenWorkspaceOptions): MeshWorkspace {
    if (options.createSession === true && options.sessionId !== undefined) {
      throw new Error("Choose either createSession or sessionId, not both.");
    }
    const selectedSession = options.createSession === true
      ? createWorkspaceSessionId()
      : options.sessionId;
    const effectiveOptions = {
      ...options,
      ...(selectedSession === undefined ? {} : { sessionId: selectedSession }),
    };
    if (options.sessionId !== undefined) {
      const selection = inspectWorkspaceStorage(effectiveOptions);
      if (
        selection.registered &&
        !selection.sessionRegistered &&
        selection.migrationSourceDirectory === undefined
      ) {
        throw new Error(
          `Unknown Mesh session ${options.sessionId} for workspace ${selection.root}.`,
        );
      }
    }
    // Validate provided or legacy config before registering or migrating local state.
    const initialPreview = previewWorkspaceConfig(effectiveOptions);
    const storage = prepareWorkspaceStorage({
      root: initialPreview.root,
      meshHome: initialPreview.meshHome,
      workspaceId: initialPreview.workspaceId,
      sessionId: initialPreview.sessionId,
    });
    const preview = previewWorkspaceConfig({
      ...effectiveOptions,
      root: storage.root,
      meshHome: storage.meshHome,
      workspaceId: storage.workspaceId,
      sessionId: storage.sessionId,
    });
    const {
      workspaceId,
      sessionId,
      root,
      meshHome,
      projectKey,
      registryPath,
      projectionCachePath,
      sessionDirectory,
      headerPath,
      dataDirectory,
      configPath,
      databasePath,
      config,
    } = preview;
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    let configRevision = preview.revision;
    if (preview.source === "default" && options.persistDefaultConfig !== false) {
      configRevision = saveWorkspaceConfig({
        workspaceId,
        sessionId,
        root,
        meshHome,
        config,
        expectedRevision: preview.revision,
      }).revision;
    }

    const store = new SqliteStore(databasePath);
    const room = store.room(config.roomId);
    const runtime = new CollaborationRuntime({
      room,
      cursors: store.cursors(),
      traces: store.traces(config.roomId),
      cwd: root,
    });
    const workspace = new MeshWorkspace(
      workspaceId,
      sessionId,
      root,
      meshHome,
      projectKey,
      registryPath,
      projectionCachePath,
      sessionDirectory,
      headerPath,
      dataDirectory,
      configPath,
      databasePath,
      preview.source,
      configRevision,
      config,
      store,
      runtime,
      storage,
    );
    const adapterRegistry = options.adapterRegistry ?? createBuiltinWorkspaceAdapterRegistry();
    try {
      for (const agent of config.agents) {
        const adapter = adapterRegistry.create(agent);
        workspace.#adapters.set(agent.id, adapter);
        runtime.registerAgent({
          id: agent.id,
          name: agent.name,
          handle: agent.handle,
          adapter,
          cwd: root,
          permissionPolicy: agent.permissionPolicy ?? "deny",
          respondToTeam: agent.respondToTeam ?? false,
          ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
        });
      }
      workspace.#projectionUnsubscribe = runtime.subscribe(() => workspace.#scheduleProjection());
      workspace.#scheduleProjection();
      return workspace;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  snapshot(): RoomSnapshot {
    this.#assertOpen();
    return this.runtime.snapshot();
  }

  configPreview(): WorkspaceConfigPreview {
    this.#assertOpen();
    return Object.freeze({
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      root: this.root,
      meshHome: this.meshHome,
      projectKey: this.projectKey,
      registryPath: this.registryPath,
      projectionCachePath: this.projectionCachePath,
      sessionDirectory: this.sessionDirectory,
      headerPath: this.headerPath,
      dataDirectory: this.dataDirectory,
      configPath: this.configPath,
      databasePath: this.databasePath,
      revision: this.configRevision,
      source: this.configSource,
      config: this.config,
    });
  }

  subscribe(listener: SnapshotListener): Unsubscribe {
    this.#assertOpen();
    return this.runtime.subscribe(listener);
  }

  postMessage(input: PostMessageInput): RoomEvent<RoomMessagePayload> {
    this.#assertOpen();
    return this.runtime.postMessage(input);
  }

  postText(
    text: string,
    options: Omit<PostMessageInput, "text" | "attention"> & {
      readonly attention?: MessageAttention;
    } = {},
  ): RoomEvent<RoomMessagePayload> {
    return this.postMessage({
      ...options,
      text,
      attention: options.attention ?? this.resolveAttention(text),
    });
  }

  createTask(input: CreateTaskInput): RoomEvent<TaskCreatedPayload> {
    this.#assertOpen();
    return this.runtime.createTask(input);
  }

  claimTask(
    taskId: string,
    ownerId: ParticipantId,
    options: { readonly actorId?: ParticipantId; readonly idempotencyKey?: string } = {},
  ): CommitResult<TaskClaimedPayload> {
    this.#assertOpen();
    return this.runtime.claimTask(taskId, ownerId, options);
  }

  updateTask(input: UpdateTaskInput): CommitResult<TaskUpdatedPayload> {
    this.#assertOpen();
    return this.runtime.updateTask(input);
  }

  async probeAgents(): Promise<readonly AgentProbeResult[]> {
    this.#assertOpen();
    return Promise.all(
      this.config.agents.map(async (agent) => {
        const adapter = this.#requireAdapter(agent.id);
        return Object.freeze({
          id: agent.id,
          name: agent.name,
          handle: agent.handle,
          adapter: agent.adapter,
          availability: await adapter.probe(),
        });
      }),
    );
  }

  async startAgent(agentIdOrHandle: string): Promise<void> {
    this.#assertOpen();
    await this.runtime.startAgent(this.resolveParticipant(agentIdOrHandle));
  }

  async stopAgent(agentIdOrHandle: string): Promise<void> {
    this.#assertOpen();
    await this.runtime.stopAgent(this.resolveParticipant(agentIdOrHandle));
  }

  async restartAgent(agentIdOrHandle: string): Promise<void> {
    this.#assertOpen();
    await this.runtime.restartAgent(this.resolveParticipant(agentIdOrHandle));
  }

  wakeAgent(agentIdOrHandle: string): void {
    this.#assertOpen();
    this.runtime.wakeAgent(this.resolveParticipant(agentIdOrHandle));
  }

  async startAvailableAgents(): Promise<StartAvailableAgentsResult> {
    const probes = await this.probeAgents();
    const started: ParticipantId[] = [];
    const failed: { agentId: ParticipantId; message: string }[] = [];
    for (const probe of probes) {
      if (!probe.availability.available) {
        continue;
      }
      try {
        await this.runtime.startAgent(probe.id);
        started.push(probe.id);
      } catch (error) {
        failed.push({ agentId: probe.id, message: errorMessage(error) });
      }
    }
    return Object.freeze({
      started: Object.freeze(started),
      unavailable: Object.freeze(probes.filter((probe) => !probe.availability.available)),
      failed: Object.freeze(failed),
    });
  }

  resolveParticipant(idOrHandle: string): ParticipantId {
    const normalized = idOrHandle.trim().replace(/^@/, "").toLowerCase();
    if (normalized === "human") {
      return this.runtime.humanId;
    }
    const config = this.config.agents.find(
      (agent) =>
        agent.id.toLowerCase() === normalized || agent.handle.toLowerCase() === normalized,
    );
    if (config === undefined) {
      throw new Error(`Unknown participant ${idOrHandle}.`);
    }
    return config.id;
  }

  resolveAttention(text: string): MessageAttention {
    const recipients = new Set<ParticipantId>();
    for (const match of text.matchAll(/(^|[^A-Za-z0-9:._-])@([A-Za-z0-9][A-Za-z0-9:._-]*[A-Za-z0-9_-]?)/g)) {
      const rawHandle = match[2];
      if (rawHandle === undefined) {
        continue;
      }
      const handle = trimMentionPunctuation(rawHandle).toLowerCase();
      if (handle === "team") {
        return "team";
      }
      if (handle === "human") {
        recipients.add(this.runtime.humanId);
        continue;
      }
      const agent = this.config.agents.find(
        (candidate) =>
          candidate.handle.toLowerCase() === handle || candidate.id.toLowerCase() === handle,
      );
      if (agent !== undefined) {
        recipients.add(agent.id);
      }
    }
    return recipients.size === 0 ? "team" : Object.freeze([...recipients]);
  }

  async settle(): Promise<void> {
    this.#assertOpen();
    await this.runtime.settle();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#projectionUnsubscribe?.();
    this.#projectionUnsubscribe = undefined;
    if (this.#projectionTimer !== undefined) {
      clearTimeout(this.#projectionTimer);
      this.#projectionTimer = undefined;
    }
    this.#checkpointProjection();
    try {
      await this.runtime.close();
    } finally {
      this.#store.close();
      this.#closed = true;
    }
  }

  #requireAdapter(agentId: ParticipantId): AgentAdapter {
    const adapter = this.#adapters.get(agentId);
    if (adapter === undefined) {
      throw new Error(`No adapter is configured for ${agentId}.`);
    }
    return adapter;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Mesh workspace is closed.");
    }
  }

  #scheduleProjection(): void {
    if (this.#closed || this.#projectionTimer !== undefined) return;
    this.#projectionTimer = setTimeout(() => {
      this.#projectionTimer = undefined;
      if (!this.#closed) this.#checkpointProjection();
    }, 50);
    this.#projectionTimer.unref?.();
  }

  #checkpointProjection(): void {
    try {
      const snapshot = this.runtime.snapshot();
      const firstHumanMessage = snapshot.messages.find((message) => message.from === "human");
      const latestMessage = snapshot.messages.at(-1);
      const latestTimestamp = snapshot.timeline.at(-1)?.committedAt ?? Date.now();
      recordWorkspaceSessionProjection(this.#storage, {
        title: compactProjectionText(firstHumanMessage?.text ?? "New Session", 80),
        preview: latestMessage === undefined ? "" : compactProjectionText(latestMessage.text, 160),
        updatedAt: new Date(latestTimestamp).toISOString(),
        headSequence: snapshot.headSequence,
        messageCount: snapshot.messages.length,
      });
    } catch {
      // This cache is derived and fail-soft; the Room database remains canonical.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimMentionPunctuation(value: string): string {
  return value.replace(/[.:]+$/g, "");
}

function compactProjectionText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact || "New Session";
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
