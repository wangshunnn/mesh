import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  workspaceConfigVersion,
  type WorkspaceAgentConfig,
  type WorkspaceConfig,
  type WorkspaceConfigPreview,
  type WorkspaceConfigSource,
  type WorkspaceConfigWriteResult,
} from "@ai-mesh/application";

import {
  inspectWorkspaceStorage,
  prepareWorkspaceStorage,
  type WorkspaceStorageInput,
  type WorkspaceStorageLocation,
} from "./storage.js";

export interface WorkspaceConfigInput extends WorkspaceStorageInput {
  readonly config?: WorkspaceConfig;
}

export interface SaveWorkspaceConfigInput extends WorkspaceStorageInput {
  /** Stable project id returned by the preview the caller edited. */
  readonly workspaceId: string;
  /** Stable session id returned by the preview the caller edited. */
  readonly sessionId: string;
  readonly config: WorkspaceConfig;
  /** Revision returned by the preview that the caller edited. Null means no file existed. */
  readonly expectedRevision: string | null;
}

export class WorkspaceConfigConflictError extends Error {
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;

  constructor(expectedRevision: string | null, actualRevision: string | null) {
    super("Workspace config changed after it was read. Preview it again before saving.");
    this.name = "WorkspaceConfigConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkspaceConfigLockedError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, options?: ErrorOptions) {
    super(`Workspace config is already being saved (${lockPath}).`, options);
    this.name = "WorkspaceConfigLockedError";
    this.lockPath = lockPath;
  }
}

/** Resolve the effective version-1 configuration without creating local state. */
export function previewWorkspaceConfig(options: WorkspaceConfigInput): WorkspaceConfigPreview {
  const paths = inspectWorkspaceStorage(options);
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
  } = paths;
  const legacyConfigPath = paths.migrationSourceDirectory === undefined
    ? undefined
    : join(paths.migrationSourceDirectory, "config.json");
  const source: WorkspaceConfigSource =
    options.config !== undefined
      ? "provided"
      : existsSync(configPath)
        ? "file"
        : legacyConfigPath !== undefined && existsSync(legacyConfigPath)
          ? "legacy"
          : "default";
  const serialized = source === "file"
    ? readFileSync(configPath, "utf8")
    : source === "legacy" && legacyConfigPath !== undefined
      ? readFileSync(legacyConfigPath, "utf8")
      : undefined;
  const config = options.config !== undefined
    ? validateWorkspaceConfig(options.config)
    : serialized === undefined
      ? defaultWorkspaceConfig()
      : parseWorkspaceConfig(serialized);
  return Object.freeze({
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
    revision: serialized === undefined ? null : revisionOf(serialized),
    source,
    config,
  });
}

/** Parse and normalize one versioned config document. */
export function parseWorkspaceConfig(serialized: string): WorkspaceConfig {
  try {
    return validateWorkspaceConfig(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Workspace config contains invalid JSON.", { cause: error });
    }
    throw error;
  }
}

/** Serialize one validated config into the canonical version-1 representation. */
export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  return `${JSON.stringify(validateWorkspaceConfig(config), undefined, 2)}\n`;
}

/**
 * Persist a complete config document after checking the revision observed by the caller.
 *
 * The replacement is atomic. An already-open MeshWorkspace keeps its startup snapshot;
 * callers must close and reopen it after a changed save.
 */
export function saveWorkspaceConfig(options: SaveWorkspaceConfigInput): WorkspaceConfigWriteResult {
  const serialized = serializeWorkspaceConfig(options.config);
  const paths = prepareWorkspaceStorage(options);
  const lockPath = `${paths.configPath}.lock`;
  mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });

  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new WorkspaceConfigLockedError(lockPath, { cause: error });
    }
    throw error;
  }

  let temporaryPath: string | undefined;
  try {
    writeFileSync(lockDescriptor, `${String(process.pid)}\n`, "utf8");
    const current = existsSync(paths.configPath)
      ? readFileSync(paths.configPath, "utf8")
      : undefined;
    const actualRevision = current === undefined ? null : revisionOf(current);
    if (actualRevision !== options.expectedRevision) {
      throw new WorkspaceConfigConflictError(options.expectedRevision, actualRevision);
    }

    if (current === serialized) {
      return configWriteResult(paths, parseWorkspaceConfig(serialized), actualRevision, false);
    }

    temporaryPath = join(
      paths.dataDirectory,
      `.config.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const latest = existsSync(paths.configPath)
      ? readFileSync(paths.configPath, "utf8")
      : undefined;
    const latestRevision = latest === undefined ? null : revisionOf(latest);
    if (latestRevision !== actualRevision) {
      throw new WorkspaceConfigConflictError(options.expectedRevision, latestRevision);
    }
    renameSync(temporaryPath, paths.configPath);
    temporaryPath = undefined;
    return configWriteResult(
      paths,
      parseWorkspaceConfig(serialized),
      revisionOf(serialized),
      true,
    );
  } finally {
    if (temporaryPath !== undefined) {
      rmSync(temporaryPath, { force: true });
    }
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
  }
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
  assertKnownKeys(value, ["version", "roomId", "agents"], "Workspace config");
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
    assertKnownKeys(
      entry,
      [
        "id",
        "name",
        "handle",
        "adapter",
        "command",
        "permissionPolicy",
        "respondToTeam",
        "systemPrompt",
      ],
      `Agent config ${String(index)}`,
    );
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
    const command = optionalString(entry, "command", index, false);
    const systemPrompt = optionalString(entry, "systemPrompt", index, true);
    if (entry.respondToTeam !== undefined && typeof entry.respondToTeam !== "boolean") {
      throw new Error(`Agent config ${String(index)} has an invalid respondToTeam value.`);
    }
    return Object.freeze({
      id,
      name,
      handle,
      adapter,
      ...(command === undefined ? {} : { command }),
      ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
      ...(typeof entry.respondToTeam === "boolean"
        ? { respondToTeam: entry.respondToTeam }
        : {}),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    });
  });
  return Object.freeze({
    version: workspaceConfigVersion,
    roomId: value.roomId,
    agents: Object.freeze(agents),
  });
}

function configWriteResult(
  paths: WorkspaceStorageLocation,
  config: WorkspaceConfig,
  revision: string | null,
  changed: boolean,
): WorkspaceConfigWriteResult {
  return Object.freeze({
    workspaceId: paths.workspaceId,
    sessionId: paths.sessionId,
    root: paths.root,
    meshHome: paths.meshHome,
    projectKey: paths.projectKey,
    registryPath: paths.registryPath,
    projectionCachePath: paths.projectionCachePath,
    sessionDirectory: paths.sessionDirectory,
    headerPath: paths.headerPath,
    dataDirectory: paths.dataDirectory,
    configPath: paths.configPath,
    databasePath: paths.databasePath,
    revision,
    source: "file",
    config,
    changed,
  });
}

function revisionOf(serialized: string): string {
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
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

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  index: number,
  allowEmpty: boolean,
): string | undefined {
  const found = value[key];
  if (found === undefined) {
    return undefined;
  }
  if (typeof found !== "string" || (!allowEmpty && found.length === 0)) {
    throw new Error(`Agent config ${String(index)} has an invalid ${key} value.`);
  }
  return found;
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
  label: string,
): void {
  const known = new Set(knownKeys);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown !== undefined) {
    throw new Error(`${label} has an unknown ${unknown} field.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
