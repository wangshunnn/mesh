import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
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

export interface AcpProcessAdapterOptions {
  readonly kind: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly clientName?: string;
}

export interface AcpPermissionRequest {
  readonly title: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly name: string;
    readonly kind: acp.PermissionOptionKind;
  }[];
}

export type AcpPermissionHandler = (
  request: AcpPermissionRequest,
) => Promise<string | "cancelled"> | string | "cancelled";

export interface AcpAdapterRuntimeOptions {
  readonly permissionHandler?: AcpPermissionHandler;
}

export class AcpProcessAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities = Object.freeze({
    persistentSession: true,
    streaming: true,
    cancel: true,
    loadSession: true,
    transport: "acp",
  });

  readonly #options: AcpProcessAdapterOptions;
  readonly #runtime: AcpAdapterRuntimeOptions;

  constructor(options: AcpProcessAdapterOptions, runtime: AcpAdapterRuntimeOptions = {}) {
    this.kind = options.kind;
    this.#options = options;
    this.#runtime = runtime;
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
      throw new AgentAdapterError("unavailable", availability.reason ?? "ACP agent is unavailable.");
    }
    if (!isAbsolute(config.cwd)) {
      throw new AgentAdapterError("invalid_state", "Agent cwd must be absolute.");
    }

    const child = spawn(availability.command, [...(this.#options.args ?? [])], {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...this.#options.environment,
        ...config.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      return await AcpSession.create(
        child,
        config,
        this.capabilities,
        this.#options.clientName ?? "mesh",
        this.#runtime.permissionHandler,
      );
    } catch (error) {
      child.kill();
      throw new AgentAdapterError("protocol", "Failed to initialize the ACP agent.", { cause: error });
    }
  }
}

export function createOpenCodeAdapter(
  runtime: AcpAdapterRuntimeOptions = {},
): AcpProcessAdapter {
  return new AcpProcessAdapter(
    {
      kind: "opencode",
      command: "opencode",
      args: ["acp", "--pure"],
    },
    runtime,
  );
}

class AcpSession implements AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly capabilities: AgentCapabilities;

  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: acp.ClientConnection;
  readonly #context: acp.ClientContext;
  readonly #events = new AgentEventChannel();
  readonly #protocolCapabilities: acp.AgentCapabilities | undefined;
  readonly #stderr: string[];
  readonly #systemPrompt: string | undefined;
  #systemPromptPending: boolean;
  #status: AgentSessionStatus = "ready";
  #activeTurnId: string | undefined;
  #activeText = "";
  #updateGeneration = 0;
  #stopped = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    connection: acp.ClientConnection,
    context: acp.ClientContext,
    config: AgentSessionConfig,
    capabilities: AgentCapabilities,
    sessionId: string,
    protocolCapabilities: acp.AgentCapabilities | undefined,
    stderr: string[],
  ) {
    this.#child = child;
    this.#connection = connection;
    this.#context = context;
    this.agentId = config.agentId;
    this.capabilities = capabilities;
    this.id = sessionId;
    this.#protocolCapabilities = protocolCapabilities;
    this.#stderr = stderr;
    this.#systemPrompt = config.systemPrompt;
    this.#systemPromptPending = config.sessionId === undefined && config.systemPrompt !== undefined;

    child.once("exit", (code, signal) => {
      if (this.#stopped) {
        return;
      }
      this.#stopped = true;
      if (code === 0 || signal === "SIGTERM") {
        this.#setStatus("stopped");
      } else {
        this.#setStatus("error");
        this.#events.publish({
          type: "error",
          message: `ACP process exited (${code ?? signal ?? "unknown"}): ${this.#stderr.join("").trim()}`,
          at: Date.now(),
        });
      }
      this.#events.close();
      this.#connection.close();
    });
  }

  static async create(
    child: ChildProcessWithoutNullStreams,
    config: AgentSessionConfig,
    capabilities: AgentCapabilities,
    clientName: string,
    permissionHandler: AcpPermissionHandler | undefined,
  ): Promise<AcpSession> {
    const stderr: string[] = [];
    const permissionPolicy = config.permissionPolicy ?? "deny";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (stderr.join("").length > 16_384) {
        stderr.shift();
      }
    });

    let sessionRef: AcpSession | undefined;
    const earlyUpdates = new Map<string, acp.SessionUpdate[]>();
    const client = acp
      .client({ name: clientName })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        if (permissionHandler !== undefined && permissionPolicy !== "deny") {
          const selected = await permissionHandler({
            title: params.toolCall.title ?? "Agent tool request",
            options: params.options,
          });
          return selected === "cancelled"
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: selected } };
        }

        if (permissionPolicy !== "deny") {
          const preferredKind =
            permissionPolicy === "allow-always" ? "allow_always" : "allow_once";
          const allowOption =
            params.options.find((option) => option.kind === preferredKind) ??
            params.options.find((option) => option.kind === "allow_once");
          if (allowOption !== undefined) {
            return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
          }
        }

        {
          const rejectOption = params.options.find(
            (option) => option.kind === "reject_once" || option.kind === "reject_always",
          );
          return rejectOption === undefined
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
        }
      })
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
        const path = restrictPath(config.cwd, params.path);
        return { content: await readFile(path, "utf8") };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        if (permissionPolicy === "deny") {
          throw new AgentAdapterError("permission", "File writes are disabled for this session.");
        }
        const path = restrictPath(config.cwd, params.path);
        await writeFile(path, params.content, "utf8");
        return {};
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (sessionRef !== undefined) {
          sessionRef.#handleUpdate(params.sessionId, params.update);
        } else {
          const queued = earlyUpdates.get(params.sessionId) ?? [];
          queued.push(params.update);
          earlyUpdates.set(params.sessionId, queued);
        }
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = client.connect(stream);
    const context = connection.agent;
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: permissionPolicy !== "deny" },
      },
      clientInfo: { name: clientName, version: "0.0.0" },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      connection.close();
      throw new Error(
        `ACP version mismatch: client ${acp.PROTOCOL_VERSION}, agent ${initialized.protocolVersion}.`,
      );
    }

    let sessionId = config.sessionId;
    if (sessionId === undefined) {
      const created = await context.request(acp.methods.agent.session.new, {
        cwd: resolve(config.cwd),
        mcpServers: [],
      });
      sessionId = created.sessionId;
    } else if (initialized.agentCapabilities?.sessionCapabilities?.resume != null) {
      await context.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd: resolve(config.cwd),
        mcpServers: [],
      });
    } else if (initialized.agentCapabilities?.loadSession === true) {
      await context.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: resolve(config.cwd),
        mcpServers: [],
      });
    } else {
      connection.close();
      throw new Error("The ACP agent cannot restore the requested session.");
    }

    sessionRef = new AcpSession(
      child,
      connection,
      context,
      config,
      Object.freeze({
        ...capabilities,
        loadSession:
          initialized.agentCapabilities?.loadSession === true ||
          initialized.agentCapabilities?.sessionCapabilities?.resume != null,
      }),
      sessionId,
      initialized.agentCapabilities,
      stderr,
    );
    for (const update of earlyUpdates.get(sessionId) ?? []) {
      sessionRef.#handleUpdate(sessionId, update);
    }
    return sessionRef;
  }

  get status(): AgentSessionStatus {
    return this.#status;
  }

  async prompt(input: AgentPrompt): Promise<AgentTurnResult> {
    if (this.#stopped || this.#status === "stopped" || this.#status === "error") {
      throw new AgentAdapterError("invalid_state", "Cannot prompt a stopped ACP session.");
    }
    if (this.#activeTurnId !== undefined) {
      throw new AgentAdapterError("invalid_state", "ACP session already has an active turn.");
    }

    this.#activeTurnId = input.turnId;
    this.#activeText = "";
    this.#setStatus("working");
    try {
      const promptText =
        !this.#systemPromptPending || this.#systemPrompt === undefined
          ? input.text
          : `${this.#systemPrompt}\n\n${input.text}`;
      this.#systemPromptPending = false;
      const response = await this.#context.request(acp.methods.agent.session.prompt, {
        sessionId: this.id,
        prompt: [{ type: "text", text: promptText }],
      });
      await this.#waitForSettledUpdates();
      const stopReason = mapStopReason(response.stopReason);
      this.#setStatus("waiting");
      return Object.freeze({
        turnId: input.turnId,
        text: this.#activeText,
        stopReason,
        metadata: Object.freeze({ acpStopReason: response.stopReason }),
      });
    } catch (error) {
      this.#setStatus("error");
      this.#events.publish({ type: "error", message: errorMessage(error), at: Date.now() });
      throw new AgentAdapterError("protocol", "ACP prompt failed.", { cause: error });
    } finally {
      this.#activeTurnId = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (this.#activeTurnId === undefined || this.#stopped) {
      return;
    }
    await this.#context.notify(acp.methods.agent.session.cancel, { sessionId: this.id });
  }

  events(): AsyncIterable<AgentSessionEvent> {
    return this.#events.events();
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#setStatus("stopping");
    if (this.#activeTurnId !== undefined) {
      await this.cancel();
    }
    if (this.#protocolCapabilities?.sessionCapabilities?.close != null) {
      await this.#context.request(acp.methods.agent.session.close, { sessionId: this.id });
    }
    this.#stopped = true;
    this.#connection.close();
    this.#child.kill();
    this.#setStatus("stopped");
    this.#events.close();
  }

  #handleUpdate(sessionId: string, update: acp.SessionUpdate): void {
    if (sessionId !== this.id) {
      return;
    }
    this.#updateGeneration += 1;
    const turnId = this.#activeTurnId;
    if (turnId === undefined) {
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.#activeText += update.content.text;
      this.#events.publish({
        type: "text-delta",
        turnId,
        delta: update.content.text,
        at: Date.now(),
      });
    } else if (update.sessionUpdate === "tool_call") {
      this.#events.publish({
        type: "tool-call",
        turnId,
        title: update.title,
        status: mapToolStatus(update.status),
        at: Date.now(),
        metadata: Object.freeze({ toolCallId: update.toolCallId }),
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      this.#events.publish({
        type: "tool-call",
        turnId,
        title: update.title ?? String(update.toolCallId),
        status: mapToolStatus(update.status),
        at: Date.now(),
        metadata: Object.freeze({ toolCallId: update.toolCallId }),
      });
    }
  }

  #setStatus(status: AgentSessionStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#events.publish({ type: "status", status, at: Date.now() });
  }

  async #waitForSettledUpdates(): Promise<void> {
    // The SDK reads every wire frame in order, while notification handlers may
    // complete on adjacent tasks to the prompt response. Wait until one full
    // event-loop turn observes no new update, without imposing agent latency.
    for (;;) {
      const generation = this.#updateGeneration;
      await new Promise<void>((resolveWait) => setImmediate(resolveWait));
      if (generation === this.#updateGeneration) {
        return;
      }
    }
  }
}

function mapStopReason(reason: acp.StopReason): AgentTurnResult["stopReason"] {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "refused";
  }
}

function mapToolStatus(
  status: acp.ToolCallStatus | null | undefined,
): "started" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    case null:
    case undefined:
      return "started";
  }
}

function restrictPath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new AgentAdapterError("permission", `Path ${target} is outside the session root.`);
  }
  return target;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
