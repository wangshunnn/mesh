import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
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

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

export interface WorkspaceStorageInput {
  readonly root: string;
  readonly meshHome?: string;
  /** Binds a side-effect-free preview to the registration created by a later write. */
  readonly workspaceId?: string;
}

export interface WorkspaceStorageLocation {
  readonly workspaceId: string;
  readonly root: string;
  readonly meshHome: string;
  readonly registryPath: string;
  readonly dataDirectory: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly legacyDataDirectory: string;
  readonly registered: boolean;
}

interface WorkspaceRegistryDocument {
  readonly version: typeof workspaceRegistryVersion;
  readonly workspaces: readonly WorkspaceRegistration[];
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
      `Both legacy project-local Mesh data and centralized workspace data exist. ` +
        `Resolve the conflict before opening the workspace (${legacyDataDirectory} and ${dataDirectory}).`,
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
      `Legacy project-local Mesh data overlaps the centralized workspace location. ` +
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
    super(`The Mesh workspace is already being migrated (${lockPath}).`, options);
    this.name = "WorkspaceMigrationLockedError";
    this.lockPath = lockPath;
  }
}

/** Resolve one existing project directory to its canonical workspace identity. */
export function resolveWorkspaceRoot(input: string): string {
  return realpathSync(resolve(input));
}

/** One machine-level data root shared by the CLI and Desktop. */
export function resolveMeshHome(input?: string): string {
  const configured = input ?? normalizedEnvironmentHome();
  if (configured === undefined) {
    return join(homedir(), ".mesh");
  }
  if (configured.trim().length === 0) {
    throw new Error("Mesh home cannot be empty.");
  }
  return resolve(expandTilde(configured.trim()));
}

/** Read the durable workspace list without creating MESH_HOME. */
export function listWorkspaceRegistrations(
  options: { readonly meshHome?: string } = {},
): readonly WorkspaceRegistration[] {
  return readRegistry(resolveMeshHome(options.meshHome)).workspaces;
}

/** Resolve storage paths without creating a registry, directory, or workspace file. */
export function inspectWorkspaceStorage(options: WorkspaceStorageInput): WorkspaceStorageLocation {
  const root = resolveWorkspaceRoot(options.root);
  const meshHome = resolveMeshHome(options.meshHome);
  const registry = readRegistry(meshHome);
  const existing = registry.workspaces.find((workspace) => workspace.root === root);
  const requestedId = options.workspaceId;
  if (requestedId !== undefined) {
    assertWorkspaceId(requestedId);
  }
  if (existing !== undefined && requestedId !== undefined && existing.id !== requestedId) {
    throw new WorkspaceRegistrationConflictError(
      `Workspace ${root} is registered as ${existing.id}, not ${requestedId}.`,
    );
  }
  const workspaceId = existing?.id ?? requestedId ?? randomUUID();
  const collision = registry.workspaces.find(
    (workspace) => workspace.id === workspaceId && workspace.root !== root,
  );
  if (collision !== undefined) {
    throw new WorkspaceRegistrationConflictError(
      `Workspace id ${workspaceId} already belongs to ${collision.root}.`,
    );
  }
  const location = storageLocation(root, meshHome, workspaceId, existing !== undefined);
  assertMigrationPathsDoNotOverlap(location);
  assertNoSplitStorage(location);
  return location;
}

/** Register an existing project directory and return its stable machine-local identity. */
export function registerWorkspace(options: WorkspaceStorageInput): WorkspaceRegistration {
  const inspected = inspectWorkspaceStorage(options);
  const lockPath = `${inspected.registryPath}.lock`;
  mkdirSync(inspected.meshHome, { recursive: true, mode: 0o700 });
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new WorkspaceRegistryLockedError(lockPath, { cause: error });
    }
    throw error;
  }

  try {
    writeFileSync(lockDescriptor, `${String(process.pid)}\n`, "utf8");
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
      name: (existing?.name ?? basename(inspected.root)) || inspected.root,
      createdAt: existing?.createdAt ?? now,
      lastOpenedAt: now,
    });
    const workspaces = existing === undefined
      ? [...registry.workspaces, registration]
      : registry.workspaces.map((workspace) =>
          workspace.id === registration.id ? registration : workspace,
        );
    writeRegistry(inspected.meshHome, {
      version: workspaceRegistryVersion,
      workspaces,
    });
    return registration;
  } finally {
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
  }
}

/** Register the workspace and move any pre-Phase-3A project-local state into MESH_HOME. */
export function prepareWorkspaceStorage(options: WorkspaceStorageInput): WorkspaceStorageLocation {
  const registration = registerWorkspace(options);
  const location = storageLocation(
    registration.root,
    resolveMeshHome(options.meshHome),
    registration.id,
    true,
  );
  migrateLegacyWorkspace(location);
  if (existsSync(location.dataDirectory)) {
    chmodSync(location.dataDirectory, 0o700);
  }
  return location;
}

function migrateLegacyWorkspace(location: WorkspaceStorageLocation): void {
  if (!hasWorkspaceData(location.legacyDataDirectory)) {
    return;
  }
  if (hasAnyEntry(location.dataDirectory)) {
    throw new WorkspaceMigrationConflictError(
      location.legacyDataDirectory,
      location.dataDirectory,
    );
  }

  const workspacesDirectory = join(location.meshHome, "workspaces");
  mkdirSync(workspacesDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(workspacesDirectory, `.${location.workspaceId}.migration.lock`);
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new WorkspaceMigrationLockedError(lockPath, { cause: error });
    }
    throw error;
  }

  let temporaryPath: string | undefined;
  try {
    writeFileSync(lockDescriptor, `${String(process.pid)}\n`, "utf8");
    if (!hasWorkspaceData(location.legacyDataDirectory)) {
      return;
    }
    if (hasAnyEntry(location.dataDirectory)) {
      throw new WorkspaceMigrationConflictError(
        location.legacyDataDirectory,
        location.dataDirectory,
      );
    }
    if (existsSync(location.dataDirectory)) {
      rmdirSync(location.dataDirectory);
    }
    try {
      renameSync(location.legacyDataDirectory, location.dataDirectory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EXDEV") {
        throw error;
      }
      temporaryPath = join(
        workspacesDirectory,
        `.${location.workspaceId}.${String(process.pid)}.${randomUUID()}.migration.tmp`,
      );
      cpSync(location.legacyDataDirectory, temporaryPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      renameSync(temporaryPath, location.dataDirectory);
      temporaryPath = undefined;
      rmSync(location.legacyDataDirectory, { recursive: true, force: false });
    }
  } finally {
    if (temporaryPath !== undefined) {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
  }
}

function storageLocation(
  root: string,
  meshHome: string,
  workspaceId: string,
  registered: boolean,
): WorkspaceStorageLocation {
  const dataDirectory = join(meshHome, "workspaces", workspaceId);
  return Object.freeze({
    workspaceId,
    root,
    meshHome,
    registryPath: join(meshHome, "registry.json"),
    dataDirectory,
    configPath: join(dataDirectory, "config.json"),
    databasePath: join(dataDirectory, "mesh.db"),
    legacyDataDirectory: join(root, ".mesh"),
    registered,
  });
}

function assertNoSplitStorage(location: WorkspaceStorageLocation): void {
  if (
    hasWorkspaceData(location.legacyDataDirectory) &&
    hasWorkspaceData(location.dataDirectory)
  ) {
    throw new WorkspaceMigrationConflictError(
      location.legacyDataDirectory,
      location.dataDirectory,
    );
  }
}

function assertMigrationPathsDoNotOverlap(location: WorkspaceStorageLocation): void {
  if (
    hasWorkspaceData(location.legacyDataDirectory) &&
    pathsOverlap(location.legacyDataDirectory, location.dataDirectory)
  ) {
    throw new WorkspaceStorageOverlapError(
      location.legacyDataDirectory,
      location.dataDirectory,
    );
  }
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
    if (parent === current) {
      return input;
    }
    missingSegments.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missingSegments);
}

function hasWorkspaceData(directory: string): boolean {
  return ["config.json", "mesh.db", "mesh.db-wal", "mesh.db-shm"].some((entry) =>
    existsSync(join(directory, entry)),
  );
}

function hasAnyEntry(directory: string): boolean {
  return existsSync(directory) && readdirSync(directory).length > 0;
}

function readRegistry(meshHome: string): WorkspaceRegistryDocument {
  const path = join(meshHome, "registry.json");
  if (!existsSync(path)) {
    return Object.freeze({ version: workspaceRegistryVersion, workspaces: Object.freeze([]) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
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
  assertKnownKeys(value, ["version", "workspaces"], `Mesh workspace registry ${path}`);
  if (!Array.isArray(value.workspaces)) {
    throw new Error(`Mesh workspace registry ${path} requires a workspaces array.`);
  }
  const ids = new Set<string>();
  const roots = new Set<string>();
  const workspaces = value.workspaces.map((entry, index): WorkspaceRegistration => {
    if (!isRecord(entry)) {
      throw new Error(`Workspace registration ${String(index)} must be an object.`);
    }
    assertKnownKeys(
      entry,
      ["id", "root", "name", "createdAt", "lastOpenedAt"],
      `Workspace registration ${String(index)}`,
    );
    const id = requiredString(entry, "id", index);
    assertWorkspaceId(id);
    const root = requiredString(entry, "root", index);
    if (!isAbsolute(root)) {
      throw new Error(`Workspace registration ${String(index)} has a non-absolute root.`);
    }
    const name = requiredString(entry, "name", index);
    const createdAt = requiredDate(entry, "createdAt", index);
    const lastOpenedAt = requiredDate(entry, "lastOpenedAt", index);
    if (ids.has(id) || roots.has(root)) {
      throw new Error(`Workspace registration ${String(index)} duplicates an id or root.`);
    }
    ids.add(id);
    roots.add(root);
    return Object.freeze({ id, root, name, createdAt, lastOpenedAt });
  });
  return Object.freeze({
    version: workspaceRegistryVersion,
    workspaces: Object.freeze(workspaces),
  });
}

function writeRegistry(meshHome: string, registry: WorkspaceRegistryDocument): void {
  const serialized = `${JSON.stringify(validateRegistry(registry, "pending write"), undefined, 2)}\n`;
  const temporaryPath = join(
    meshHome,
    `.registry.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporaryPath, join(meshHome, "registry.json"));
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The successful path already closed the descriptor before atomic publication.
    }
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function normalizedEnvironmentHome(): string | undefined {
  const value = process.env.MESH_HOME;
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function expandTilde(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function assertWorkspaceId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid Mesh workspace id ${value}.`);
  }
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  index: number,
): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) {
    throw new Error(`Workspace registration ${String(index)} requires ${key}.`);
  }
  return found;
}

function requiredDate(
  value: Readonly<Record<string, unknown>>,
  key: string,
  index: number,
): string {
  const found = requiredString(value, key, index);
  if (Number.isNaN(Date.parse(found))) {
    throw new Error(`Workspace registration ${String(index)} has an invalid ${key}.`);
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
