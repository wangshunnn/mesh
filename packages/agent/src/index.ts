export type AgentId = string;
export type AgentSessionId = string;
export type AgentTurnId = string;

export type AgentSessionStatus =
  | "starting"
  | "ready"
  | "working"
  | "waiting"
  | "stopping"
  | "stopped"
  | "error";

export interface AgentCapabilities {
  readonly persistentSession: boolean;
  readonly streaming: boolean;
  readonly cancel: boolean;
  readonly loadSession: boolean;
  readonly transport: "acp" | "native" | "scripted";
}

export interface AgentAvailability {
  readonly available: boolean;
  readonly command: string;
  readonly version?: string;
  readonly reason?: string;
}

export type AgentPermissionPolicy = "deny" | "allow-once" | "allow-always";

export interface AgentSessionConfig {
  readonly agentId: AgentId;
  readonly cwd: string;
  readonly sessionId?: AgentSessionId;
  readonly systemPrompt?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly permissionPolicy?: AgentPermissionPolicy;
}

export interface AgentPrompt {
  readonly turnId: AgentTurnId;
  readonly text: string;
}

export interface AgentTurnResult {
  readonly turnId: AgentTurnId;
  readonly text: string;
  readonly stopReason: "completed" | "cancelled" | "refused" | "error";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AgentSessionEvent =
  | {
      readonly type: "status";
      readonly status: AgentSessionStatus;
      readonly at: number;
    }
  | {
      readonly type: "text-delta";
      readonly turnId: AgentTurnId;
      readonly delta: string;
      readonly at: number;
    }
  | {
      readonly type: "tool-call";
      readonly turnId: AgentTurnId;
      readonly title: string;
      readonly status: "started" | "completed" | "failed";
      readonly at: number;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly at: number;
    };

export interface AgentSession {
  readonly id: AgentSessionId;
  readonly agentId: AgentId;
  readonly capabilities: AgentCapabilities;
  readonly status: AgentSessionStatus;

  prompt(input: AgentPrompt): Promise<AgentTurnResult>;
  cancel(): Promise<void>;
  events(): AsyncIterable<AgentSessionEvent>;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities;

  probe(): Promise<AgentAvailability>;
  start(config: AgentSessionConfig): Promise<AgentSession>;
}

export interface ScriptedTurnContext {
  readonly agentId: AgentId;
  readonly sessionId: AgentSessionId;
  readonly turn: number;
  readonly prompt: AgentPrompt;
}

export type ScriptedTurnHandler = (
  context: ScriptedTurnContext,
) => Promise<string | AgentTurnResult> | string | AgentTurnResult;

/** Deterministic adapter for collaboration evals, examples, and offline demos. */
export class ScriptedAgentAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities = Object.freeze({
    persistentSession: true,
    streaming: true,
    cancel: true,
    loadSession: true,
    transport: "scripted",
  });

  readonly #handler: ScriptedTurnHandler;
  #nextSession = 1;

  constructor(kind: string, handler: ScriptedTurnHandler) {
    this.kind = kind;
    this.#handler = handler;
  }

  async probe(): Promise<AgentAvailability> {
    return Object.freeze({ available: true, command: this.kind, version: "scripted" });
  }

  async start(config: AgentSessionConfig): Promise<AgentSession> {
    const id = config.sessionId ?? `${this.kind}:${String(this.#nextSession)}`;
    this.#nextSession += 1;
    return new ScriptedSession(id, config.agentId, this.capabilities, this.#handler);
  }
}

class ScriptedSession implements AgentSession {
  readonly id: AgentSessionId;
  readonly agentId: AgentId;
  readonly capabilities: AgentCapabilities;

  readonly #handler: ScriptedTurnHandler;
  readonly #events = new AgentEventChannel();
  #status: AgentSessionStatus = "ready";
  #turn = 0;
  #cancelled = false;
  #stopped = false;

  constructor(
    id: AgentSessionId,
    agentId: AgentId,
    capabilities: AgentCapabilities,
    handler: ScriptedTurnHandler,
  ) {
    this.id = id;
    this.agentId = agentId;
    this.capabilities = capabilities;
    this.#handler = handler;
  }

  get status(): AgentSessionStatus {
    return this.#status;
  }

  async prompt(input: AgentPrompt): Promise<AgentTurnResult> {
    if (this.#stopped || this.#status === "working") {
      throw new AgentAdapterError("invalid_state", "Scripted session cannot accept this prompt.");
    }
    this.#turn += 1;
    this.#cancelled = false;
    this.#setStatus("working");
    try {
      const scripted = await this.#handler({
        agentId: this.agentId,
        sessionId: this.id,
        turn: this.#turn,
        prompt: input,
      });
      if (this.#cancelled) {
        this.#setStatus("waiting");
        return Object.freeze({ turnId: input.turnId, text: "", stopReason: "cancelled" });
      }
      const result =
        typeof scripted === "string"
          ? Object.freeze({ turnId: input.turnId, text: scripted, stopReason: "completed" as const })
          : scripted;
      if (result.text.length > 0) {
        this.#events.publish({
          type: "text-delta",
          turnId: input.turnId,
          delta: result.text,
          at: Date.now(),
        });
      }
      this.#setStatus("waiting");
      return result;
    } catch (error) {
      this.#setStatus("error");
      this.#events.publish({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
  }

  events(): AsyncIterable<AgentSessionEvent> {
    return this.#events.events();
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#setStatus("stopped");
    this.#events.close();
  }

  #setStatus(status: AgentSessionStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#events.publish({ type: "status", status, at: Date.now() });
  }
}

export class AgentAdapterError extends Error {
  readonly code: "unavailable" | "protocol" | "process" | "permission" | "invalid_state";

  constructor(
    code: AgentAdapterError["code"],
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AgentAdapterError";
    this.code = code;
  }
}

/** A small multicast queue used by adapter implementations. */
export class AgentEventChannel {
  readonly #subscribers = new Set<AsyncQueue<AgentSessionEvent>>();
  #closed = false;

  publish(event: AgentSessionEvent): void {
    if (this.#closed) {
      return;
    }
    for (const subscriber of this.#subscribers) {
      subscriber.push(event);
    }
  }

  events(): AsyncIterable<AgentSessionEvent> {
    const queue = new AsyncQueue<AgentSessionEvent>();
    if (this.#closed) {
      queue.close();
    } else {
      this.#subscribers.add(queue);
    }
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = queue[Symbol.asyncIterator]();
        return {
          next: () => iterator.next(),
          return: async () => {
            this.#subscribers.delete(queue);
            queue.close();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  close(): void {
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.close();
    }
    this.#subscribers.clear();
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
    } else {
      this.#values.push(value);
    }
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
