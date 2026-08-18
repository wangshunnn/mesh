import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import {
  AgentAdapterError,
  AgentEventChannel,
  type AgentAdapter,
  type AgentAvailability,
  type AgentCapabilities,
  type AgentPrompt,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSessionEvent,
  type AgentSessionStatus,
  type AgentTurnResult,
} from "@ai-mesh/agent";

const probeCache = new Map<string, {
  readonly expiresAt: number;
  readonly result: Promise<AgentAvailability>;
}>();

export interface NativeCommandAdapterOptions {
  readonly kind: string;
  readonly command: string;
  readonly buildInitialArgs: (config: AgentSessionConfig) => readonly string[];
  readonly buildResumeArgs: (
    config: AgentSessionConfig,
    nativeSessionId: string,
  ) => readonly string[];
  readonly parseLine: (line: string) => NativeOutputEvent | undefined;
  readonly environment?: Readonly<Record<string, string>>;
  readonly streaming?: boolean;
}

export type NativeOutputEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "text-delta"; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly title: string;
      readonly status: "started" | "completed" | "failed";
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "error"; readonly message: string };

export class NativeCommandAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities;

  readonly #options: NativeCommandAdapterOptions;

  constructor(options: NativeCommandAdapterOptions) {
    this.kind = options.kind;
    this.#options = options;
    this.capabilities = Object.freeze({
      persistentSession: true,
      streaming: options.streaming ?? true,
      cancel: true,
      loadSession: true,
      transport: "native",
    });
  }

  probe(): Promise<AgentAvailability> {
    const now = Date.now();
    const cached = probeCache.get(this.#options.command);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }
    const result = this.#probe();
    probeCache.set(this.#options.command, { expiresAt: now + 30_000, result });
    return result;
  }

  async #probe(): Promise<AgentAvailability> {
    const command = await resolveCommand(this.#options.command);
    if (command === undefined) {
      return Object.freeze({
        available: false,
        command: this.#options.command,
        reason: `Command ${this.#options.command} was not found on PATH.`,
      });
    }
    const version = await readCommandVersion(command);
    return Object.freeze({
      available: true,
      command,
      ...(version === undefined ? {} : { version }),
    });
  }

  async start(config: AgentSessionConfig): Promise<AgentSession> {
    const availability = await this.probe();
    if (!availability.available) {
      throw new AgentAdapterError("unavailable", availability.reason ?? "Native agent is unavailable.");
    }
    return new NativeSession(availability.command, this.#options, config, this.capabilities);
  }
}

export function createCodexAdapter(command = "codex"): NativeCommandAdapter {
  return new NativeCommandAdapter({
    kind: "codex",
    command,
    streaming: false,
    buildInitialArgs: (config) => [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      (config.permissionPolicy ?? "deny") === "deny" ? "read-only" : "workspace-write",
      "-C",
      config.cwd,
      "-",
    ],
    buildResumeArgs: (config, sessionId) => [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      (config.permissionPolicy ?? "deny") === "deny" ? "read-only" : "workspace-write",
      "resume",
      sessionId,
      "-",
    ],
    parseLine: parseCodexJsonLine,
  });
}

class NativeSession implements AgentSession {
  readonly agentId: string;
  readonly capabilities: AgentCapabilities;

  readonly #command: string;
  readonly #options: NativeCommandAdapterOptions;
  readonly #config: AgentSessionConfig;
  readonly #events = new AgentEventChannel();
  #id: string;
  #status: AgentSessionStatus = "ready";
  #activeProcess: ChildProcessWithoutNullStreams | undefined;
  #systemPromptPending: boolean;
  #stopped = false;

  constructor(
    command: string,
    options: NativeCommandAdapterOptions,
    config: AgentSessionConfig,
    capabilities: AgentCapabilities,
  ) {
    this.#command = command;
    this.#options = options;
    this.#config = config;
    this.agentId = config.agentId;
    this.capabilities = capabilities;
    this.#id = config.sessionId ?? `pending:${config.agentId}`;
    this.#systemPromptPending = config.sessionId === undefined && config.systemPrompt !== undefined;
  }

  get id(): string {
    return this.#id;
  }

  get status(): AgentSessionStatus {
    return this.#status;
  }

  async prompt(input: AgentPrompt): Promise<AgentTurnResult> {
    if (this.#stopped) {
      throw new AgentAdapterError("invalid_state", "Cannot prompt a stopped native session.");
    }
    if (this.#activeProcess !== undefined) {
      throw new AgentAdapterError("invalid_state", "Native session already has an active turn.");
    }

    const hasNativeSession = !this.#id.startsWith("pending:");
    const args = hasNativeSession
      ? this.#options.buildResumeArgs(this.#config, this.#id)
      : this.#options.buildInitialArgs(this.#config);
    const child = spawn(this.#command, [...args], {
      cwd: this.#config.cwd,
      env: { ...process.env, ...this.#options.environment, ...this.#config.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#activeProcess = child;
    this.#setStatus("working");

    let output = "";
    let stderr = "";
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          output += this.#handleLine(input.turnId, line);
        }
      }
    });

    child.stdin.end(
      !this.#systemPromptPending || this.#config.systemPrompt === undefined
        ? input.text
        : `${this.#config.systemPrompt}\n\n${input.text}`,
    );
    this.#systemPromptPending = false;

    const result = await new Promise<AgentTurnResult>((resolveTurn, rejectTurn) => {
      let settled = false;
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.#activeProcess = undefined;
        this.#setStatus("error");
        rejectTurn(new AgentAdapterError("process", "Native agent failed to start.", { cause: error }));
      });
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        this.#activeProcess = undefined;
        if (buffer.trim().length > 0) {
          output += this.#handleLine(input.turnId, buffer.trim());
        }
        if (signal !== null) {
          this.#setStatus("waiting");
          resolveTurn(
            Object.freeze({ turnId: input.turnId, text: output, stopReason: "cancelled" }),
          );
          return;
        }
        if (code !== 0) {
          this.#setStatus("error");
          const message = stderr.trim() || `Native agent exited with code ${String(code)}.`;
          this.#events.publish({ type: "error", message, at: Date.now() });
          rejectTurn(new AgentAdapterError("process", message));
          return;
        }
        this.#setStatus("waiting");
        resolveTurn(
          Object.freeze({ turnId: input.turnId, text: output, stopReason: "completed" }),
        );
      });
    });
    return result;
  }

  async cancel(): Promise<void> {
    this.#activeProcess?.kill("SIGINT");
  }

  events(): AsyncIterable<AgentSessionEvent> {
    return this.#events.events();
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#setStatus("stopping");
    this.#activeProcess?.kill("SIGTERM");
    this.#activeProcess = undefined;
    this.#stopped = true;
    this.#setStatus("stopped");
    this.#events.close();
  }

  #handleLine(turnId: string, line: string): string {
    let parsed: NativeOutputEvent | undefined;
    try {
      parsed = this.#options.parseLine(line);
    } catch (error) {
      this.#events.publish({
        type: "error",
        message: `Could not parse native agent output: ${errorMessage(error)}`,
        at: Date.now(),
      });
      return "";
    }
    if (parsed === undefined) {
      return "";
    }
    switch (parsed.type) {
      case "session":
        this.#id = parsed.sessionId;
        return "";
      case "text-delta":
        this.#events.publish({ type: "text-delta", turnId, delta: parsed.delta, at: Date.now() });
        return parsed.delta;
      case "tool-call":
        this.#events.publish({
          type: "tool-call",
          turnId,
          title: parsed.title,
          status: parsed.status,
          ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
          at: Date.now(),
        });
        return "";
      case "error":
        this.#events.publish({ type: "error", message: parsed.message, at: Date.now() });
        return "";
    }
  }

  #setStatus(status: AgentSessionStatus): void {
    if (status === this.#status) {
      return;
    }
    this.#status = status;
    this.#events.publish({ type: "status", status, at: Date.now() });
  }
}

export function parseCodexJsonLine(line: string): NativeOutputEvent | undefined {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "thread.started" && typeof value.thread_id === "string") {
    return { type: "session", sessionId: value.thread_id };
  }
  if (value.type === "error") {
    return {
      type: "error",
      message: typeof value.message === "string" ? value.message : line,
    };
  }
  if (value.type === "item.completed" && isRecord(value.item)) {
    const item = value.item;
    if (item.type === "agent_message" && typeof item.text === "string") {
      return { type: "text-delta", delta: item.text };
    }
    if (item.type === "command_execution") {
      return {
        type: "tool-call",
        title: typeof item.command === "string" ? item.command : "Command execution",
        status: item.status === "failed" ? "failed" : "completed",
        metadata: Object.freeze({ itemId: item.id, exitCode: item.exit_code }),
      };
    }
  }
  if (value.type === "item.started" && isRecord(value.item)) {
    const item = value.item;
    if (item.type === "command_execution") {
      return {
        type: "tool-call",
        title: typeof item.command === "string" ? item.command : "Command execution",
        status: "started",
        metadata: Object.freeze({ itemId: item.id }),
      };
    }
  }
  return undefined;
}

async function resolveCommand(command: string): Promise<string | undefined> {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH without spawning a synchronous helper process.
    }
  }
  return undefined;
}

function readCommandVersion(command: string): Promise<string | undefined> {
  return new Promise((resolveVersion) => {
    execFile(command, ["--version"], { encoding: "utf8", timeout: 5_000 }, (error, stdout, stderr) => {
      if (error !== null) {
        resolveVersion(undefined);
        return;
      }
      resolveVersion(stdout.trim() || stderr.trim() || undefined);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
