import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { AcpProcessAdapter } from "@ai-mesh/adapter-acp";
import { createCodexAdapter } from "@ai-mesh/adapter-native";
import type { AgentAdapter, AgentAvailability, AgentPermissionPolicy } from "@ai-mesh/agent";
import {
  CollaborationRuntime,
  type CreateTaskInput,
  type PostMessageInput,
  type RoomSnapshot,
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

export type {
  AgentView,
  MessageView,
  RoomSnapshot,
  TaskView,
} from "@ai-mesh/collaboration";
export type { TraceRecord } from "@ai-mesh/protocol";

export const workspaceConfigVersion = 1;

export type WorkspaceAdapterKind = "opencode-acp" | "codex-native";

export interface WorkspaceAgentConfig {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapter: WorkspaceAdapterKind;
  readonly command?: string;
  readonly permissionPolicy?: AgentPermissionPolicy;
  readonly respondToTeam?: boolean;
  readonly systemPrompt?: string;
}

export interface WorkspaceConfig {
  readonly version: typeof workspaceConfigVersion;
  readonly roomId: string;
  readonly agents: readonly WorkspaceAgentConfig[];
}

export interface OpenWorkspaceOptions {
  readonly root: string;
  readonly dataDirectory?: string;
  readonly config?: WorkspaceConfig;
  readonly persistDefaultConfig?: boolean;
}

export type WorkspaceConfigSource = "provided" | "file" | "default";

export interface WorkspaceConfigPreview {
  readonly root: string;
  readonly dataDirectory: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly source: WorkspaceConfigSource;
  readonly config: WorkspaceConfig;
}

export interface AgentProbeResult {
  readonly id: ParticipantId;
  readonly name: string;
  readonly handle: string;
  readonly adapter: WorkspaceAdapterKind;
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

export class MeshWorkspace {
  readonly root: string;
  readonly dataDirectory: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly config: WorkspaceConfig;
  readonly runtime: CollaborationRuntime;

  readonly #store: SqliteStore;
  readonly #adapters = new Map<ParticipantId, AgentAdapter>();
  #closed = false;

  private constructor(
    root: string,
    dataDirectory: string,
    configPath: string,
    databasePath: string,
    config: WorkspaceConfig,
    store: SqliteStore,
    runtime: CollaborationRuntime,
  ) {
    this.root = root;
    this.dataDirectory = dataDirectory;
    this.configPath = configPath;
    this.databasePath = databasePath;
    this.config = config;
    this.#store = store;
    this.runtime = runtime;
  }

  static open(options: OpenWorkspaceOptions): MeshWorkspace {
    const preview = previewWorkspaceConfig(options);
    const { root, dataDirectory, configPath, databasePath, config } = preview;
    mkdirSync(dataDirectory, { recursive: true });
    if (preview.source === "default" && options.persistDefaultConfig !== false) {
      writeFileSync(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
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
      root,
      dataDirectory,
      configPath,
      databasePath,
      config,
      store,
      runtime,
    );
    try {
      for (const agent of config.agents) {
        const adapter = createWorkspaceAdapter(agent);
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
}

export function previewWorkspaceConfig(
  options: Pick<OpenWorkspaceOptions, "root" | "dataDirectory" | "config">,
): WorkspaceConfigPreview {
  const root = resolve(options.root);
  const dataDirectory = resolve(options.dataDirectory ?? join(root, ".mesh"));
  const configPath = join(dataDirectory, "config.json");
  const databasePath = join(dataDirectory, "mesh.db");
  const source: WorkspaceConfigSource =
    options.config !== undefined ? "provided" : existsSync(configPath) ? "file" : "default";
  const config =
    options.config !== undefined
      ? validateWorkspaceConfig(options.config)
      : source === "file"
        ? validateWorkspaceConfig(JSON.parse(readFileSync(configPath, "utf8")))
        : defaultWorkspaceConfig();
  return Object.freeze({
    root,
    dataDirectory,
    configPath,
    databasePath,
    source,
    config,
  });
}

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return Object.freeze({
    version: workspaceConfigVersion,
    roomId: "room:main",
    agents: Object.freeze([
      Object.freeze({
        id: "agent:opencode",
        name: "OpenCode",
        handle: "opencode",
        adapter: "opencode-acp" as const,
        permissionPolicy: "deny" as const,
        respondToTeam: true,
      }),
      Object.freeze({
        id: "agent:codex",
        name: "Codex",
        handle: "codex",
        adapter: "codex-native" as const,
        permissionPolicy: "deny" as const,
        respondToTeam: true,
      }),
    ]),
  });
}

export function validateWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value) || value.version !== workspaceConfigVersion) {
    throw new Error(`Workspace config must use version ${String(workspaceConfigVersion)}.`);
  }
  if (typeof value.roomId !== "string" || value.roomId.length === 0) {
    throw new Error("Workspace config requires a roomId.");
  }
  if (!Array.isArray(value.agents)) {
    throw new Error("Workspace config agents must be an array.");
  }
  const ids = new Set<string>();
  const handles = new Set<string>();
  const agents = value.agents.map((entry, index): WorkspaceAgentConfig => {
    if (!isRecord(entry)) {
      throw new Error(`Agent config ${String(index)} must be an object.`);
    }
    const id = requiredString(entry, "id", index);
    const name = requiredString(entry, "name", index);
    const handle = requiredString(entry, "handle", index).replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9:._-]*$/.test(handle)) {
      throw new Error(`Agent config ${String(index)} has an invalid handle.`);
    }
    const adapter = entry.adapter;
    if (adapter !== "opencode-acp" && adapter !== "codex-native") {
      throw new Error(`Agent config ${String(index)} has an unsupported adapter.`);
    }
    if (ids.has(id) || handles.has(handle)) {
      throw new Error(`Agent config ${String(index)} duplicates an id or handle.`);
    }
    ids.add(id);
    handles.add(handle);
    const permissionPolicy = entry.permissionPolicy;
    if (
      permissionPolicy !== undefined &&
      permissionPolicy !== "deny" &&
      permissionPolicy !== "allow-once" &&
      permissionPolicy !== "allow-always"
    ) {
      throw new Error(`Agent config ${String(index)} has an invalid permission policy.`);
    }
    return Object.freeze({
      id,
      name,
      handle,
      adapter,
      ...(typeof entry.command === "string" ? { command: entry.command } : {}),
      ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
      ...(typeof entry.respondToTeam === "boolean"
        ? { respondToTeam: entry.respondToTeam }
        : {}),
      ...(typeof entry.systemPrompt === "string" ? { systemPrompt: entry.systemPrompt } : {}),
    });
  });
  return Object.freeze({
    version: workspaceConfigVersion,
    roomId: value.roomId,
    agents: Object.freeze(agents),
  });
}

function createWorkspaceAdapter(config: WorkspaceAgentConfig): AgentAdapter {
  switch (config.adapter) {
    case "opencode-acp":
      return new AcpProcessAdapter({
        kind: "opencode",
        command: config.command ?? "opencode",
        args: ["acp", "--pure"],
      });
    case "codex-native":
      return createCodexAdapter(config.command ?? "codex");
  }
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  index: number,
): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) {
    throw new Error(`Agent config ${String(index)} requires ${key}.`);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimMentionPunctuation(value: string): string {
  return value.replace(/[.:]+$/g, "");
}

export function resolveWorkspaceRoot(input: string): string {
  return isAbsolute(input) ? input : resolve(input);
}
