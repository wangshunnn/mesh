import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  workspaceConfigVersion,
  type WorkspaceAgentConfig,
  type WorkspaceConfig,
  type WorkspaceConfigPreview,
  type WorkspaceConfigSource,
} from "@ai-mesh/application";

export interface WorkspaceConfigInput {
  readonly root: string;
  readonly dataDirectory?: string;
  readonly config?: WorkspaceConfig;
}

/** Resolve the effective version-1 configuration without creating local state. */
export function previewWorkspaceConfig(options: WorkspaceConfigInput): WorkspaceConfigPreview {
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

export function resolveWorkspaceRoot(input: string): string {
  return isAbsolute(input) ? input : resolve(input);
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
