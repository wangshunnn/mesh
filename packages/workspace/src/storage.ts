import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const workspaceRegistryVersion = 1;
export const workspaceSessionHeaderVersion = 1;
export const workspaceSessionProjectionCacheVersion = 1;

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  /** Newest-created sessions first. Opening an existing session does not reorder it. */
  readonly sessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string;
}

export interface WorkspaceSessionHeader {
  readonly version: typeof workspaceSessionHeaderVersion;
  readonly id: string;
  readonly workspaceId: string;
  /** Immutable canonical project path captured when this session was created. */
  readonly cwd: string;
  readonly createdAt: string;
}

export interface WorkspaceSessionProjection {
  readonly sessionId: string;
  readonly title: string;
  readonly preview: string;
  readonly updatedAt: string;
  readonly headSequence: number;
  readonly messageCount: number;
}

export type WorkspaceSessionStatus = "ok" | "missing" | "corrupt";

export interface WorkspaceSessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: WorkspaceSessionStatus;
  readonly title: string;
  readonly preview: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headSequence: number;
  readonly messageCount: number;
  readonly archived: boolean;
  readonly projectKey: string;
  readonly dataDirectory: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly detail?: string;
}

export interface WorkspaceStorageInput {
  readonly root: string;
  readonly meshHome?: string;
  /** Binds a side-effect-free preview to a stable project registration. */
  readonly workspaceId?: string;
  /** Binds a preview/open/save to one session. Omit to select the workspace's newest session. */
  readonly sessionId?: string;
}

export interface WorkspaceStorageLocation {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly meshHome: string;
  readonly projectKey: string;
  readonly registryPath: string;
  readonly projectionCachePath: string;
  readonly sessionsRoot: string;
  readonly projectDirectory: string;
  readonly dataDirectory: string;
  readonly sessionDirectory: string;
  readonly headerPath: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly legacyProjectDataDirectory: string;
  readonly legacyWorkspaceDataDirectory: string;
  readonly migrationSourceDirectory?: string;
  readonly registered: boolean;
  readonly sessionRegistered: boolean;
}

interface WorkspaceRegistryDocument {
  readonly version: typeof workspaceRegistryVersion;
  readonly workspaceIds: readonly string[];
  readonly archivedSessionIds: readonly string[];
  readonly workspaces: readonly WorkspaceRegistration[];
}

interface LegacyWorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

interface LegacyWorkspaceRegistryDocument {
  readonly version: 1;
  readonly workspaces: readonly LegacyWorkspaceRegistration[];
}

interface WorkspaceSessionProjectionCacheDocument {
  readonly version: typeof workspaceSessionProjectionCacheVersion;
  readonly sessions: Readonly<Record<string, WorkspaceSessionProjection>>;
}

export class WorkspaceRegistrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRegistrationConflictError";
  }
}

export class WorkspaceRegistryLockedError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, options?: ErrorOptions) {
    super(`The Mesh workspace registry is already being updated (${lockPath}).`, options);
    this.name = "WorkspaceRegistryLockedError";
    this.lockPath = lockPath;
  }
}

export class WorkspaceMigrationConflictError extends Error {
  readonly legacyDataDirectory: string;
  readonly dataDirectory: string;

  constructor(legacyDataDirectory: string, dataDirectory: string) {
    super(
      `More than one Mesh data location could own this session. ` +
        `Resolve the conflict before opening it (${legacyDataDirectory} and ${dataDirectory}).`,
    );
    this.name = "WorkspaceMigrationConflictError";
    this.legacyDataDirectory = legacyDataDirectory;
    this.dataDirectory = dataDirectory;
  }
}

export class WorkspaceStorageOverlapError extends Error {
  readonly legacyDataDirectory: string;
  readonly dataDirectory: string;

  constructor(legacyDataDirectory: string, dataDirectory: string) {
    super(
      `Legacy Mesh data overlaps the session location. ` +
        `Choose a different MESH_HOME or migrate the data manually (${legacyDataDirectory} and ${dataDirectory}).`,
    );
    this.name = "WorkspaceStorageOverlapError";
    this.legacyDataDirectory = legacyDataDirectory;
    this.dataDirectory = dataDirectory;
  }
}

export class WorkspaceMigrationLockedError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, options?: ErrorOptions) {
    super(`The Mesh session is already being migrated (${lockPath}).`, options);
    this.name = "WorkspaceMigrationLockedError";
    this.lockPath = lockPath;
  }
}

export class WorkspaceSessionCorruptError extends Error {
  readonly headerPath: string;

  constructor(headerPath: string, message: string, options?: ErrorOptions) {
    super(`Mesh session header ${headerPath} is invalid: ${message}`, options);
    this.name = "WorkspaceSessionCorruptError";
    this.headerPath = headerPath;
  }
}

/** Resolve one existing project directory to its canonical workspace identity. */
export function resolveWorkspaceRoot(input: string): string {
  return realpathSync(resolve(input));
}

/** One machine-level data root shared by the CLI and Desktop. */
export function resolveMeshHome(input?: string): string {
  const configured = input ?? normalizedEnvironmentHome();
  if (configured === undefined) return join(homedir(), ".mesh");
  if (configured.trim().length === 0) throw new Error("Mesh home cannot be empty.");
  return resolve(expandTilde(configured.trim()));
}

/** Generate the opaque, globally unique id used by one Room-backed local session. */
export function createWorkspaceSessionId(): string {
  return `session-${randomUUID()}`;
}

/** Human-readable, collision-resistant grouping key derived from the canonical cwd. */
export function workspaceProjectKey(root: string): string {
  const canonical = resolveWorkspaceRoot(root);
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `--${slug.slice(0, 234)}--${digest}`;
}

/** Read the durable workspace list without creating MESH_HOME. */
export function listWorkspaceRegistrations(
  options: { readonly meshHome?: string } = {},
): readonly WorkspaceRegistration[] {
  return orderedWorkspaces(readRegistry(resolveMeshHome(options.meshHome)));
}

/** List one project's sessions from its registry account and cold projection cache. */
export function listWorkspaceSessions(options: WorkspaceStorageInput): readonly WorkspaceSessionSummary[] {
  const root = resolveWorkspaceRoot(options.root);
  const meshHome = resolveMeshHome(options.meshHome);
  const registry = readRegistry(meshHome);
  const workspace = registry.workspaces.find((candidate) => candidate.root === root);
  if (workspace === undefined) return Object.freeze([]);
  if (options.workspaceId !== undefined && options.workspaceId !== workspace.id) {
    throw new WorkspaceRegistrationConflictError(
      `Workspace ${root} is registered as ${workspace.id}, not ${options.workspaceId}.`,
    );
  }
  const cache = readProjectionCacheFailSoft(meshHome);
  return Object.freeze(workspace.sessionIds.map((sessionId) => {
    const location = storageLocation(root, meshHome, workspace.id, sessionId, true, true);
    const projection = cache.sessions[sessionId];
    const archived = registry.archivedSessionIds.includes(sessionId);
    if (!existsSync(location.headerPath)) {
      return sessionSummary(location, workspace.createdAt, projection, archived, "missing", "Session header is missing.");
    }
    try {
      const header = readSessionHeader(location.headerPath);
      assertHeaderBinding(header, location);
      return sessionSummary(location, header.createdAt, projection, archived, "ok");
    } catch (error) {
      return sessionSummary(
        location,
        workspace.createdAt,
        projection,
        archived,
        "corrupt",
        errorMessage(error),
      );
    }
  }));
}

/** Resolve project/session storage paths without creating any local state. */
export function inspectWorkspaceStorage(options: WorkspaceStorageInput): WorkspaceStorageLocation {
  const root = resolveWorkspaceRoot(options.root);
  const meshHome = resolveMeshHome(options.meshHome);
  const registry = readRegistry(meshHome);
  const existing = registry.workspaces.find((workspace) => workspace.root === root);
  const requestedWorkspaceId = options.workspaceId;
  if (requestedWorkspaceId !== undefined) assertWorkspaceId(requestedWorkspaceId);
  if (
    existing !== undefined &&
    requestedWorkspaceId !== undefined &&
    existing.id !== requestedWorkspaceId
  ) {
    throw new WorkspaceRegistrationConflictError(
      `Workspace ${root} is registered as ${existing.id}, not ${requestedWorkspaceId}.`,
    );
  }
  const workspaceId = existing?.id ?? requestedWorkspaceId ?? randomUUID();
  const workspaceCollision = registry.workspaces.find(
    (workspace) => workspace.id === workspaceId && workspace.root !== root,
  );
  if (workspaceCollision !== undefined) {
    throw new WorkspaceRegistrationConflictError(
      `Workspace id ${workspaceId} already belongs to ${workspaceCollision.root}.`,
    );
  }

  const requestedSessionId = options.sessionId;
  if (requestedSessionId !== undefined) assertSessionId(requestedSessionId);
  const sessionId = requestedSessionId ?? existing?.sessionIds[0] ?? createWorkspaceSessionId();
  const sessionOwner = registry.workspaces.find(
    (workspace) => workspace.id !== workspaceId && workspace.sessionIds.includes(sessionId),
  );
  if (sessionOwner !== undefined) {
    throw new WorkspaceRegistrationConflictError(
      `Session id ${sessionId} already belongs to workspace ${sessionOwner.id}.`,
    );
  }

  const location = storageLocation(
    root,
    meshHome,
    workspaceId,
    sessionId,
    existing !== undefined,
    existing?.sessionIds.includes(sessionId) ?? false,
  );
  return inspectMigration(location);
}

/** Register an existing project directory without creating or attaching a session. */
export function registerWorkspace(options: WorkspaceStorageInput): WorkspaceRegistration {
  const inspected = inspectWorkspaceStorage(options);
  mkdirSync(dirname(inspected.registryPath), { recursive: true, mode: 0o700 });
  const lockPath = `${inspected.registryPath}.lock`;
  const lockDescriptor = acquireLock(lockPath, WorkspaceRegistryLockedError);
  try {
    const registry = readRegistry(inspected.meshHome);
    const existing = registry.workspaces.find((workspace) => workspace.root === inspected.root);
    if (existing !== undefined && existing.id !== inspected.workspaceId) {
      throw new WorkspaceRegistrationConflictError(
        `Workspace ${inspected.root} was concurrently registered as ${existing.id}.`,
      );
    }
    const collision = registry.workspaces.find(
      (workspace) => workspace.id === inspected.workspaceId && workspace.root !== inspected.root,
    );
    if (collision !== undefined) {
      throw new WorkspaceRegistrationConflictError(
        `Workspace id ${inspected.workspaceId} already belongs to ${collision.root}.`,
      );
    }
    const now = new Date().toISOString();
    const registration = Object.freeze({
      id: inspected.workspaceId,
      root: inspected.root,
      name: existing?.name ?? (basename(inspected.root) || inspected.root),
      sessionIds: existing?.sessionIds ?? Object.freeze([]),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastOpenedAt: now,
    });
    const workspaces = existing === undefined
      ? [registration, ...registry.workspaces]
      : registry.workspaces.map((workspace) =>
          workspace.id === registration.id ? registration : workspace,
        );
    const workspaceIds = existing === undefined
      ? [registration.id, ...registry.workspaceIds]
      : registry.workspaceIds;
    writeRegistry(inspected.meshHome, {
      version: workspaceRegistryVersion,
      workspaceIds,
      archivedSessionIds: registry.archivedSessionIds,
      workspaces,
    });
    return registration;
  } finally {
    releaseLock(lockDescriptor, lockPath);
  }
}

/** Register the project, migrate old storage, materialize a header, and attach the session. */
export function prepareWorkspaceStorage(options: WorkspaceStorageInput): WorkspaceStorageLocation {
  const inspected = inspectWorkspaceStorage(options);
  const registration = registerWorkspace({
    root: inspected.root,
    meshHome: inspected.meshHome,
    workspaceId: inspected.workspaceId,
    sessionId: inspected.sessionId,
  });
  let location = inspectWorkspaceStorage({
    root: registration.root,
    meshHome: inspected.meshHome,
    workspaceId: registration.id,
    sessionId: inspected.sessionId,
  });
  migrateLegacySession(location);
  mkdirSync(location.sessionDirectory, { recursive: true, mode: 0o700 });
  const createdAt = location.migrationSourceDirectory === undefined
    ? new Date().toISOString()
    : registration.createdAt;
  ensureSessionHeader(location, createdAt);
  attachSession(location);
  chmodSync(location.sessionDirectory, 0o700);
  cleanupLegacyRegistry(location.meshHome);
  location = storageLocation(
    location.root,
    location.meshHome,
    location.workspaceId,
    location.sessionId,
    true,
    true,
  );
  return location;
}

/** Replace one derived sidebar projection atomically. The canonical Room database is untouched. */
export function recordWorkspaceSessionProjection(
  location: WorkspaceStorageLocation,
  projection: Omit<WorkspaceSessionProjection, "sessionId">,
): void {
  assertSessionProjection({ sessionId: location.sessionId, ...projection }, location.projectionCachePath);
  mkdirSync(dirname(location.projectionCachePath), { recursive: true, mode: 0o700 });
  const lockPath = `${location.projectionCachePath}.lock`;
  const lockDescriptor = acquireLock(lockPath, WorkspaceRegistryLockedError);
  try {
    const cache = readProjectionCacheFailSoft(location.meshHome);
    writeProjectionCache(location.meshHome, {
      version: workspaceSessionProjectionCacheVersion,
      sessions: {
        ...cache.sessions,
        [location.sessionId]: Object.freeze({ sessionId: location.sessionId, ...projection }),
      },
    });
  } finally {
    releaseLock(lockDescriptor, lockPath);
  }
}

function inspectMigration(location: WorkspaceStorageLocation): WorkspaceStorageLocation {
  const sources = [
    location.legacyProjectDataDirectory,
    location.legacyWorkspaceDataDirectory,
  ].filter(hasWorkspaceData);
  if (sources.length > 1) {
    throw new WorkspaceMigrationConflictError(sources[0]!, sources[1]!);
  }
  const migrationSourceDirectory = sources[0];
  if (migrationSourceDirectory !== undefined && hasAnyEntry(location.sessionDirectory)) {
    throw new WorkspaceMigrationConflictError(
      migrationSourceDirectory,
      location.sessionDirectory,
    );
  }
  if (
    migrationSourceDirectory !== undefined &&
    pathsOverlap(migrationSourceDirectory, location.sessionDirectory)
  ) {
    throw new WorkspaceStorageOverlapError(
      migrationSourceDirectory,
      location.sessionDirectory,
    );
  }
  if (existsSync(location.headerPath)) {
    assertHeaderBinding(readSessionHeader(location.headerPath), location);
  }
  return Object.freeze({
    ...location,
    ...(migrationSourceDirectory === undefined ? {} : { migrationSourceDirectory }),
  });
}

function migrateLegacySession(location: WorkspaceStorageLocation): void {
  const source = location.migrationSourceDirectory;
  if (source === undefined || !hasWorkspaceData(source)) return;
  if (hasAnyEntry(location.sessionDirectory)) {
    throw new WorkspaceMigrationConflictError(source, location.sessionDirectory);
  }
  mkdirSync(location.projectDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(location.projectDirectory, `.${location.sessionId}.migration.lock`);
  const lockDescriptor = acquireLock(lockPath, WorkspaceMigrationLockedError);
  let temporaryPath: string | undefined;
  try {
    if (!hasWorkspaceData(source)) return;
    if (hasAnyEntry(location.sessionDirectory)) {
      throw new WorkspaceMigrationConflictError(source, location.sessionDirectory);
    }
    if (existsSync(location.sessionDirectory)) rmdirSync(location.sessionDirectory);
    try {
      renameSync(source, location.sessionDirectory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EXDEV") throw error;
      temporaryPath = join(
        location.projectDirectory,
        `.${location.sessionId}.${String(process.pid)}.${randomUUID()}.migration.tmp`,
      );
      cpSync(source, temporaryPath, { recursive: true, errorOnExist: true, force: false });
      renameSync(temporaryPath, location.sessionDirectory);
      temporaryPath = undefined;
      rmSync(source, { recursive: true, force: false });
    }
  } finally {
    if (temporaryPath !== undefined) {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
    releaseLock(lockDescriptor, lockPath);
  }
}

function attachSession(location: WorkspaceStorageLocation): void {
  const lockPath = `${location.registryPath}.lock`;
  const lockDescriptor = acquireLock(lockPath, WorkspaceRegistryLockedError);
  try {
    const registry = readRegistry(location.meshHome);
    const workspace = registry.workspaces.find((candidate) => candidate.id === location.workspaceId);
    if (workspace === undefined || workspace.root !== location.root) {
      throw new WorkspaceRegistrationConflictError(
        `Workspace ${location.workspaceId} is not registered for ${location.root}.`,
      );
    }
    const owner = registry.workspaces.find(
      (candidate) => candidate.id !== workspace.id && candidate.sessionIds.includes(location.sessionId),
    );
    if (owner !== undefined) {
      throw new WorkspaceRegistrationConflictError(
        `Session ${location.sessionId} belongs to workspace ${owner.id}.`,
      );
    }
    const now = new Date().toISOString();
    const sessionIds = workspace.sessionIds.includes(location.sessionId)
      ? workspace.sessionIds
      : Object.freeze([location.sessionId, ...workspace.sessionIds]);
    const next = Object.freeze({ ...workspace, sessionIds, updatedAt: now, lastOpenedAt: now });
    writeRegistry(location.meshHome, {
      ...registry,
      workspaces: registry.workspaces.map((candidate) =>
        candidate.id === next.id ? next : candidate,
      ),
    });
  } finally {
    releaseLock(lockDescriptor, lockPath);
  }
}

function storageLocation(
  root: string,
  meshHome: string,
  workspaceId: string,
  sessionId: string,
  registered: boolean,
  sessionRegistered: boolean,
): WorkspaceStorageLocation {
  const projectKey = workspaceProjectKey(root);
  const sessionsRoot = join(meshHome, "sessions");
  const projectDirectory = join(sessionsRoot, projectKey);
  const sessionDirectory = join(projectDirectory, sessionId);
  return Object.freeze({
    workspaceId,
    sessionId,
    root,
    meshHome,
    projectKey,
    registryPath: join(meshHome, "storages", "workspace.json"),
    projectionCachePath: join(meshHome, "storages", "session-projection-cache.json"),
    sessionsRoot,
    projectDirectory,
    dataDirectory: sessionDirectory,
    sessionDirectory,
    headerPath: join(sessionDirectory, "header.json"),
    configPath: join(sessionDirectory, "config.json"),
    databasePath: join(sessionDirectory, "mesh.db"),
    legacyProjectDataDirectory: join(root, ".mesh"),
    legacyWorkspaceDataDirectory: join(meshHome, "workspaces", workspaceId),
    registered,
    sessionRegistered,
  });
}

function ensureSessionHeader(location: WorkspaceStorageLocation, createdAt: string): void {
  if (existsSync(location.headerPath)) {
    assertHeaderBinding(readSessionHeader(location.headerPath), location);
    return;
  }
  const header = Object.freeze({
    version: workspaceSessionHeaderVersion,
    id: location.sessionId,
    workspaceId: location.workspaceId,
    cwd: location.root,
    createdAt,
  });
  writeAtomicJson(location.headerPath, validateSessionHeader(header, location.headerPath));
}

function readSessionHeader(path: string): WorkspaceSessionHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WorkspaceSessionCorruptError(path, "invalid JSON", { cause: error });
    }
    throw error;
  }
  return validateSessionHeader(parsed, path);
}

function validateSessionHeader(value: unknown, path: string): WorkspaceSessionHeader {
  if (!isRecord(value) || value.version !== workspaceSessionHeaderVersion) {
    throw new WorkspaceSessionCorruptError(path, "expected version 1");
  }
  assertKnownKeys(value, ["version", "id", "workspaceId", "cwd", "createdAt"], `Mesh session header ${path}`);
  const id = recordString(value, "id", `Mesh session header ${path}`);
  const workspaceId = recordString(value, "workspaceId", `Mesh session header ${path}`);
  const cwd = recordString(value, "cwd", `Mesh session header ${path}`);
  const createdAt = recordDate(value, "createdAt", `Mesh session header ${path}`);
  try {
    assertSessionId(id);
    assertWorkspaceId(workspaceId);
  } catch (error) {
    throw new WorkspaceSessionCorruptError(path, errorMessage(error), { cause: error });
  }
  if (!isAbsolute(cwd)) throw new WorkspaceSessionCorruptError(path, "cwd is not absolute");
  return Object.freeze({ version: workspaceSessionHeaderVersion, id, workspaceId, cwd, createdAt });
}

function assertHeaderBinding(header: WorkspaceSessionHeader, location: WorkspaceStorageLocation): void {
  if (
    header.id !== location.sessionId ||
    header.workspaceId !== location.workspaceId ||
    header.cwd !== location.root
  ) {
    throw new WorkspaceSessionCorruptError(
      location.headerPath,
      `identity does not match session ${location.sessionId} in workspace ${location.workspaceId}`,
    );
  }
}

function sessionSummary(
  location: WorkspaceStorageLocation,
  createdAt: string,
  projection: WorkspaceSessionProjection | undefined,
  archived: boolean,
  status: WorkspaceSessionStatus,
  detail?: string,
): WorkspaceSessionSummary {
  return Object.freeze({
    id: location.sessionId,
    workspaceId: location.workspaceId,
    status,
    title: projection?.title ?? "New Session",
    preview: projection?.preview ?? "",
    createdAt,
    updatedAt: projection?.updatedAt ?? createdAt,
    headSequence: projection?.headSequence ?? 0,
    messageCount: projection?.messageCount ?? 0,
    archived,
    projectKey: location.projectKey,
    dataDirectory: location.dataDirectory,
    configPath: location.configPath,
    databasePath: location.databasePath,
    ...(detail === undefined ? {} : { detail }),
  });
}

function readRegistry(meshHome: string): WorkspaceRegistryDocument {
  const path = join(meshHome, "storages", "workspace.json");
  if (existsSync(path)) return parseRegistry(readFileSync(path, "utf8"), path);
  const legacyPath = join(meshHome, "registry.json");
  if (!existsSync(legacyPath)) return emptyRegistry();
  return convertLegacyRegistry(parseLegacyRegistry(readFileSync(legacyPath, "utf8"), legacyPath));
}

function parseRegistry(serialized: string, path: string): WorkspaceRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Mesh workspace registry ${path} contains invalid JSON.`, { cause: error });
    }
    throw error;
  }
  return validateRegistry(parsed, path);
}

function validateRegistry(value: unknown, path: string): WorkspaceRegistryDocument {
  if (!isRecord(value) || value.version !== workspaceRegistryVersion) {
    throw new Error(`Mesh workspace registry ${path} must use version 1.`);
  }
  assertKnownKeys(
    value,
    ["version", "workspaceIds", "archivedSessionIds", "workspaces"],
    `Mesh workspace registry ${path}`,
  );
  if (!Array.isArray(value.workspaceIds) || !Array.isArray(value.archivedSessionIds) || !Array.isArray(value.workspaces)) {
    throw new Error(`Mesh workspace registry ${path} requires workspaceIds, archivedSessionIds, and workspaces arrays.`);
  }
  const workspaceIds = value.workspaceIds.map((entry) => {
    if (typeof entry !== "string") throw new Error(`Mesh workspace registry ${path} has an invalid workspace id.`);
    assertWorkspaceId(entry);
    return entry;
  });
  const archivedSessionIds = value.archivedSessionIds.map((entry) => {
    if (typeof entry !== "string") throw new Error(`Mesh workspace registry ${path} has an invalid archived session id.`);
    assertSessionId(entry);
    return entry;
  });
  const roots = new Set<string>();
  const ids = new Set<string>();
  const ownedSessions = new Set<string>();
  const workspaces = value.workspaces.map((entry, index): WorkspaceRegistration => {
    if (!isRecord(entry)) throw new Error(`Workspace registration ${String(index)} must be an object.`);
    assertKnownKeys(
      entry,
      ["id", "root", "name", "sessionIds", "createdAt", "updatedAt", "lastOpenedAt"],
      `Workspace registration ${String(index)}`,
    );
    const id = recordString(entry, "id", `Workspace registration ${String(index)}`);
    assertWorkspaceId(id);
    const root = recordString(entry, "root", `Workspace registration ${String(index)}`);
    if (!isAbsolute(root)) throw new Error(`Workspace registration ${String(index)} has a non-absolute root.`);
    const name = recordString(entry, "name", `Workspace registration ${String(index)}`);
    if (!Array.isArray(entry.sessionIds)) throw new Error(`Workspace registration ${String(index)} requires sessionIds.`);
    const sessionIds = entry.sessionIds.map((sessionId) => {
      if (typeof sessionId !== "string") throw new Error(`Workspace registration ${String(index)} has an invalid session id.`);
      assertSessionId(sessionId);
      if (ownedSessions.has(sessionId)) throw new Error(`Session ${sessionId} is owned by more than one workspace.`);
      ownedSessions.add(sessionId);
      return sessionId;
    });
    const createdAt = recordDate(entry, "createdAt", `Workspace registration ${String(index)}`);
    const updatedAt = recordDate(entry, "updatedAt", `Workspace registration ${String(index)}`);
    const lastOpenedAt = recordDate(entry, "lastOpenedAt", `Workspace registration ${String(index)}`);
    if (ids.has(id) || roots.has(root)) throw new Error(`Workspace registration ${String(index)} duplicates an id or root.`);
    ids.add(id);
    roots.add(root);
    return Object.freeze({ id, root, name, sessionIds: Object.freeze(sessionIds), createdAt, updatedAt, lastOpenedAt });
  });
  if (
    new Set(workspaceIds).size !== workspaceIds.length ||
    workspaceIds.length !== workspaces.length ||
    workspaceIds.some((id) => !ids.has(id))
  ) {
    throw new Error(`Mesh workspace registry ${path} has an invalid workspace order.`);
  }
  if (archivedSessionIds.some((id) => !ownedSessions.has(id))) {
    throw new Error(`Mesh workspace registry ${path} archives an unowned session.`);
  }
  return Object.freeze({
    version: workspaceRegistryVersion,
    workspaceIds: Object.freeze(workspaceIds),
    archivedSessionIds: Object.freeze(archivedSessionIds),
    workspaces: Object.freeze(workspaces),
  });
}

function parseLegacyRegistry(serialized: string, path: string): LegacyWorkspaceRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Legacy Mesh workspace registry ${path} contains invalid JSON.`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.workspaces)) {
    throw new Error(`Legacy Mesh workspace registry ${path} must use version 1.`);
  }
  const workspaces = parsed.workspaces.map((entry, index): LegacyWorkspaceRegistration => {
    if (!isRecord(entry)) throw new Error(`Legacy workspace registration ${String(index)} must be an object.`);
    assertKnownKeys(entry, ["id", "root", "name", "createdAt", "lastOpenedAt"], `Legacy workspace registration ${String(index)}`);
    const id = recordString(entry, "id", `Legacy workspace registration ${String(index)}`);
    assertWorkspaceId(id);
    const root = recordString(entry, "root", `Legacy workspace registration ${String(index)}`);
    const name = recordString(entry, "name", `Legacy workspace registration ${String(index)}`);
    const createdAt = recordDate(entry, "createdAt", `Legacy workspace registration ${String(index)}`);
    const lastOpenedAt = recordDate(entry, "lastOpenedAt", `Legacy workspace registration ${String(index)}`);
    return Object.freeze({ id, root, name, createdAt, lastOpenedAt });
  });
  return Object.freeze({ version: 1, workspaces: Object.freeze(workspaces) });
}

function convertLegacyRegistry(legacy: LegacyWorkspaceRegistryDocument): WorkspaceRegistryDocument {
  return Object.freeze({
    version: workspaceRegistryVersion,
    workspaceIds: Object.freeze(legacy.workspaces.map((workspace) => workspace.id)),
    archivedSessionIds: Object.freeze([]),
    workspaces: Object.freeze(legacy.workspaces.map((workspace) => Object.freeze({
      ...workspace,
      sessionIds: Object.freeze([]),
      updatedAt: workspace.lastOpenedAt,
    }))),
  });
}

function orderedWorkspaces(registry: WorkspaceRegistryDocument): readonly WorkspaceRegistration[] {
  const byId = new Map(registry.workspaces.map((workspace) => [workspace.id, workspace]));
  return Object.freeze(registry.workspaceIds.map((id) => byId.get(id)!));
}

function emptyRegistry(): WorkspaceRegistryDocument {
  return Object.freeze({
    version: workspaceRegistryVersion,
    workspaceIds: Object.freeze([]),
    archivedSessionIds: Object.freeze([]),
    workspaces: Object.freeze([]),
  });
}

function writeRegistry(meshHome: string, registry: WorkspaceRegistryDocument): void {
  const path = join(meshHome, "storages", "workspace.json");
  writeAtomicJson(path, validateRegistry(registry, "pending write"));
}

function readProjectionCache(meshHome: string): WorkspaceSessionProjectionCacheDocument {
  const path = join(meshHome, "storages", "session-projection-cache.json");
  if (!existsSync(path)) {
    return Object.freeze({ version: workspaceSessionProjectionCacheVersion, sessions: Object.freeze({}) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Mesh session projection cache ${path} contains invalid JSON.`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== workspaceSessionProjectionCacheVersion || !isRecord(parsed.sessions)) {
    throw new Error(`Mesh session projection cache ${path} must use version 1.`);
  }
  assertKnownKeys(parsed, ["version", "sessions"], `Mesh session projection cache ${path}`);
  const sessions: Record<string, WorkspaceSessionProjection> = {};
  for (const [id, value] of Object.entries(parsed.sessions)) {
    assertSessionId(id);
    sessions[id] = assertSessionProjection(value, path);
    if (sessions[id]!.sessionId !== id) throw new Error(`Mesh session projection cache ${path} has a mismatched id.`);
  }
  return Object.freeze({ version: workspaceSessionProjectionCacheVersion, sessions: Object.freeze(sessions) });
}

function readProjectionCacheFailSoft(meshHome: string): WorkspaceSessionProjectionCacheDocument {
  try {
    return readProjectionCache(meshHome);
  } catch {
    // This index is derived from canonical session databases and may be rebuilt lazily.
    return Object.freeze({
      version: workspaceSessionProjectionCacheVersion,
      sessions: Object.freeze({}),
    });
  }
}

function assertSessionProjection(value: unknown, path: string): WorkspaceSessionProjection {
  if (!isRecord(value)) throw new Error(`Mesh session projection cache ${path} has an invalid row.`);
  assertKnownKeys(value, ["sessionId", "title", "preview", "updatedAt", "headSequence", "messageCount"], `Mesh session projection cache ${path}`);
  const sessionId = recordString(value, "sessionId", `Mesh session projection cache ${path}`);
  assertSessionId(sessionId);
  const title = recordString(value, "title", `Mesh session projection cache ${path}`);
  const preview = typeof value.preview === "string" ? value.preview : undefined;
  if (preview === undefined) throw new Error(`Mesh session projection cache ${path} has an invalid preview.`);
  const updatedAt = recordDate(value, "updatedAt", `Mesh session projection cache ${path}`);
  const headSequence = recordNonNegativeInteger(value, "headSequence", path);
  const messageCount = recordNonNegativeInteger(value, "messageCount", path);
  return Object.freeze({ sessionId, title, preview, updatedAt, headSequence, messageCount });
}

function writeProjectionCache(meshHome: string, cache: WorkspaceSessionProjectionCacheDocument): void {
  const path = join(meshHome, "storages", "session-projection-cache.json");
  writeAtomicJson(path, cache);
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The successful path closes before atomic publication.
    }
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function cleanupLegacyRegistry(meshHome: string): void {
  const legacyPath = join(meshHome, "registry.json");
  if (!existsSync(legacyPath)) return;
  const legacy = parseLegacyRegistry(readFileSync(legacyPath, "utf8"), legacyPath);
  if (legacy.workspaces.some((workspace) => hasWorkspaceData(join(meshHome, "workspaces", workspace.id)))) return;
  rmSync(legacyPath);
  const legacyWorkspacesDirectory = join(meshHome, "workspaces");
  if (existsSync(legacyWorkspacesDirectory) && readdirSync(legacyWorkspacesDirectory).length === 0) {
    rmdirSync(legacyWorkspacesDirectory);
  }
}

function acquireLock<T extends new (lockPath: string, options?: ErrorOptions) => Error>(
  lockPath: string,
  ErrorType: T,
): number {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ErrorType(lockPath, { cause: error });
    }
    throw error;
  }
  writeFileSync(descriptor, `${String(process.pid)}\n`, "utf8");
  return descriptor;
}

function releaseLock(descriptor: number, lockPath: string): void {
  closeSync(descriptor);
  rmSync(lockPath, { force: true });
}

function hasWorkspaceData(directory: string): boolean {
  return ["config.json", "mesh.db", "mesh.db-wal", "mesh.db-shm"].some((entry) =>
    existsSync(join(directory, entry)),
  );
}

function hasAnyEntry(directory: string): boolean {
  return existsSync(directory) && readdirSync(directory).length > 0;
}

function pathsOverlap(first: string, second: string): boolean {
  return pathContains(first, second) || pathContains(second, first);
}

function pathContains(parent: string, candidate: string): boolean {
  const path = relative(canonicalizeExistingPrefix(parent), canonicalizeExistingPrefix(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function canonicalizeExistingPrefix(input: string): string {
  let current = input;
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return input;
    missingSegments.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missingSegments);
}

function normalizedEnvironmentHome(): string | undefined {
  const value = process.env.MESH_HOME;
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function assertWorkspaceId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid Mesh workspace id ${value}.`);
  }
}

function assertSessionId(value: string): void {
  if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid Mesh session id ${value}.`);
  }
}

function recordString(value: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) throw new Error(`${label} requires ${key}.`);
  return found;
}

function recordDate(value: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const found = recordString(value, key, label);
  if (Number.isNaN(Date.parse(found))) throw new Error(`${label} has an invalid ${key}.`);
  return found;
}

function recordNonNegativeInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): number {
  const found = value[key];
  if (typeof found !== "number" || !Number.isSafeInteger(found) || found < 0) {
    throw new Error(`Mesh session projection cache ${path} has an invalid ${key}.`);
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
  if (unknown !== undefined) throw new Error(`${label} has an unknown ${unknown} field.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
