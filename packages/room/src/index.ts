import { randomUUID } from "node:crypto";

import {
  CoreAction,
  sameSubject,
  subjectKey,
  type CausalBasis,
  type CommitResult,
  type Committed,
  type Intent,
  type NeedsRebase,
  type Rejected,
  type RoomEvent,
  type RoomId,
  type SubjectConflict,
  type SubjectRef,
} from "@ai-mesh/protocol";

export type CommitSemantics = "append" | "compare-and-append" | "exclusive";

export interface ActionPolicy {
  readonly action: string;
  readonly semantics: CommitSemantics;
  /**
   * Compare-and-append actions always require a basis for their target subject.
   * Exclusive actions can opt in when eligibility also depends on current state.
   */
  readonly requireTargetBasis?: boolean;
  /**
   * Require another exclusive slot to exist on the same subject before this
   * action is eligible. This lets the policy layer reject mutations of an
   * entity that has not been created yet.
   */
  readonly requiredExclusiveGroup?: string;
  /**
   * Exclusive actions with the same group compete for one slot on a subject.
   * By default the action name is the group.
   */
  readonly exclusiveGroup?: string;
}

export const coreActionPolicies: readonly ActionPolicy[] = [
  { action: CoreAction.threadMessageAppend, semantics: "append" },
  {
    action: CoreAction.threadReplyCommit,
    semantics: "compare-and-append",
    requireTargetBasis: true,
  },
  { action: CoreAction.participantPresenceSet, semantics: "append" },
  { action: CoreAction.agentTurnComplete, semantics: "append" },
  {
    action: CoreAction.taskCreate,
    semantics: "exclusive",
    exclusiveGroup: "task.exists",
  },
  {
    action: CoreAction.taskClaim,
    semantics: "exclusive",
    requireTargetBasis: true,
    requiredExclusiveGroup: "task.exists",
    exclusiveGroup: "task.owner",
  },
  {
    action: CoreAction.taskUpdate,
    semantics: "compare-and-append",
    requireTargetBasis: true,
    requiredExclusiveGroup: "task.exists",
  },
  { action: CoreAction.decisionPropose, semantics: "append" },
  { action: CoreAction.artifactPublish, semantics: "append" },
];

export interface EventQuery {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface SubjectSnapshot {
  readonly subject: SubjectRef;
  readonly version: number;
  readonly events: readonly RoomEvent[];
}

export interface CommitNotification {
  readonly roomId: RoomId;
  readonly headSequence: number;
  readonly event: RoomEvent;
}

export type CommitListener = (notification: CommitNotification) => void;
export type Unsubscribe = () => void;

export interface RoomLedger {
  readonly roomId: RoomId;
  readonly headSequence: number;

  commit<TPayload>(intent: Intent<TPayload>): CommitResult<TPayload>;
  readEvents(query?: EventQuery): readonly RoomEvent[];
  snapshot(subject: SubjectRef): SubjectSnapshot;
  currentVersion(subject: SubjectRef): number;
  subscribe(listener: CommitListener): Unsubscribe;
}

export interface StoredIdempotencyResult {
  readonly fingerprint: string;
  readonly result: CommitResult;
}

/**
 * The transactional storage contract beneath the policy engine.
 * Implementations must commit every mutation made in a callback atomically or
 * commit none of them when the callback throws.
 */
export interface RoomBackendTransaction {
  readonly headSequence: number;

  currentVersion(subject: SubjectRef): number;
  readSubjectEventsAfter(subject: SubjectRef, version: number): readonly RoomEvent[];
  getIdempotency(key: string): StoredIdempotencyResult | undefined;
  putIdempotency(key: string, value: StoredIdempotencyResult): void;
  findExclusive(subject: SubjectRef, group: string): RoomEvent | undefined;
  append(event: RoomEvent, exclusiveGroup: string | undefined): void;
}

export interface RoomBackend {
  readonly roomId: RoomId;
  readonly headSequence: number;

  transaction<T>(work: (transaction: RoomBackendTransaction) => T): T;
  readEvents(query?: EventQuery): readonly RoomEvent[];
  snapshot(subject: SubjectRef): SubjectSnapshot;
  currentVersion(subject: SubjectRef): number;
}

export interface PolicyRoomLedgerOptions {
  readonly policies?: readonly ActionPolicy[];
  readonly now?: () => number;
  readonly createEventId?: () => string;
}

/**
 * The single semantic commit engine used by every storage implementation.
 * Clients choose an action; server-owned policies choose its consistency rules.
 */
export class PolicyRoomLedger implements RoomLedger {
  readonly roomId: RoomId;

  readonly #backend: RoomBackend;
  readonly #policies = new Map<string, ActionPolicy>();
  readonly #listeners = new Set<CommitListener>();
  readonly #now: () => number;
  readonly #createEventId: () => string;

  constructor(backend: RoomBackend, options: PolicyRoomLedgerOptions = {}) {
    this.#backend = backend;
    this.roomId = backend.roomId;
    this.#now = options.now ?? Date.now;
    this.#createEventId = options.createEventId ?? randomUUID;

    const policies = options.policies ?? coreActionPolicies;
    for (const policy of policies) {
      if (this.#policies.has(policy.action)) {
        throw new Error(`Duplicate action policy: ${policy.action}`);
      }
      this.#policies.set(policy.action, policy);
    }
  }

  get headSequence(): number {
    return this.#backend.headSequence;
  }

  commit<TPayload>(intent: Intent<TPayload>): CommitResult<TPayload> {
    if (intent.roomId !== this.roomId) {
      throw new Error(`Intent targets room ${intent.roomId}, but this ledger is ${this.roomId}`);
    }

    let committedEvent: RoomEvent<TPayload> | undefined;
    const result = this.#backend.transaction((transaction) => {
      const fingerprint = canonicalStringify(intent);
      const prior = transaction.getIdempotency(intent.idempotencyKey);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return reject(
            "idempotency_conflict",
            `Idempotency key ${intent.idempotencyKey} was already used for a different intent.`,
          );
        }

        return replayResult(prior.result) as CommitResult<TPayload>;
      }

      const remember = <TResult extends CommitResult<TPayload>>(value: TResult): TResult => {
        transaction.putIdempotency(intent.idempotencyKey, { fingerprint, result: value });
        return value;
      };

      const policy = this.#policies.get(intent.action);
      if (policy === undefined) {
        return remember(reject("unknown_action", `No commit policy is registered for ${intent.action}.`));
      }

      if (
        policy.requiredExclusiveGroup !== undefined &&
        transaction.findExclusive(intent.subject, policy.requiredExclusiveGroup) === undefined
      ) {
        return remember(
          reject(
            "not_found",
            `${subjectKey(intent.subject)} must exist before ${intent.action} can be committed.`,
            { currentVersion: transaction.currentVersion(intent.subject) },
          ),
        );
      }

      const bases = normalizeBases(intent.basedOn);
      if (bases instanceof Error) {
        return remember(reject("invalid_basis", bases.message));
      }

      if (policy.semantics === "exclusive") {
        const exclusiveGroup = policy.exclusiveGroup ?? policy.action;
        const existing = transaction.findExclusive(intent.subject, exclusiveGroup);
        if (existing !== undefined) {
          return remember(
            reject(
              "already_claimed",
              `${exclusiveGroup} is already committed for ${subjectKey(intent.subject)}.`,
              {
                currentVersion: transaction.currentVersion(intent.subject),
                conflictingEvent: existing,
              },
            ),
          );
        }
      }

      const requiresTargetBasis =
        policy.semantics === "compare-and-append" || policy.requireTargetBasis === true;
      if (requiresTargetBasis && !bases.some((basis) => sameSubject(basis.subject, intent.subject))) {
        return remember(
          reject(
            "missing_basis",
            `${intent.action} requires a causal basis for ${subjectKey(intent.subject)}.`,
            { currentVersion: transaction.currentVersion(intent.subject) },
          ),
        );
      }

      const basisValidation = validateBases(transaction, bases);
      if (basisValidation.status !== "valid") {
        return remember(basisValidation.result as CommitResult<TPayload>);
      }

      const event: RoomEvent<TPayload> = deepFreeze({
        id: this.#createEventId(),
        sequence: transaction.headSequence + 1,
        roomId: this.roomId,
        actorId: intent.actorId,
        subject: { ...intent.subject },
        subjectVersion: transaction.currentVersion(intent.subject) + 1,
        action: intent.action,
        payload: structuredClone(intent.payload),
        intentId: intent.id,
        idempotencyKey: intent.idempotencyKey,
        causedBy: bases.map(cloneBasis),
        committedAt: this.#now(),
      });

      transaction.append(
        event,
        policy.semantics === "exclusive" ? (policy.exclusiveGroup ?? policy.action) : undefined,
      );
      const committed: Committed<TPayload> = Object.freeze({
        status: "committed",
        event,
        replayed: false,
      });
      transaction.putIdempotency(intent.idempotencyKey, { fingerprint, result: committed });
      committedEvent = event;
      return committed;
    });

    if (committedEvent !== undefined) {
      this.#notify(committedEvent);
    }
    return result;
  }

  readEvents(query: EventQuery = {}): readonly RoomEvent[] {
    return this.#backend.readEvents(query);
  }

  snapshot(subject: SubjectRef): SubjectSnapshot {
    return this.#backend.snapshot(subject);
  }

  currentVersion(subject: SubjectRef): number {
    return this.#backend.currentVersion(subject);
  }

  subscribe(listener: CommitListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(event: RoomEvent): void {
    const notification: CommitNotification = Object.freeze({
      roomId: this.roomId,
      headSequence: event.sequence,
      event,
    });
    for (const listener of this.#listeners) {
      try {
        listener(notification);
      } catch {
        // Observers must never be able to roll back or fail a committed event.
      }
    }
  }
}

export interface InMemoryRoomLedgerOptions extends PolicyRoomLedgerOptions {}

export class InMemoryRoomLedger extends PolicyRoomLedger {
  constructor(roomId: RoomId, options: InMemoryRoomLedgerOptions = {}) {
    super(new InMemoryRoomBackend(roomId), options);
  }
}

class InMemoryRoomBackend implements RoomBackend {
  readonly roomId: RoomId;

  readonly #events: RoomEvent[] = [];
  readonly #eventsBySubject = new Map<string, RoomEvent[]>();
  readonly #versions = new Map<string, number>();
  readonly #exclusiveCommits = new Map<string, RoomEvent>();
  readonly #idempotencyResults = new Map<string, StoredIdempotencyResult>();

  constructor(roomId: RoomId) {
    this.roomId = roomId;
  }

  get headSequence(): number {
    return this.#events.length;
  }

  transaction<T>(work: (transaction: RoomBackendTransaction) => T): T {
    const pendingIdempotency = new Map<string, StoredIdempotencyResult>();
    let pendingAppend:
      | { readonly event: RoomEvent; readonly exclusiveGroup: string | undefined }
      | undefined;

    const transaction: RoomBackendTransaction = {
      headSequence: this.headSequence,
      currentVersion: (subject) => this.currentVersion(subject),
      readSubjectEventsAfter: (subject, version) =>
        Object.freeze(
          (this.#eventsBySubject.get(subjectKey(subject)) ?? []).filter(
            (event) => event.subjectVersion > version,
          ),
        ),
      getIdempotency: (key) => pendingIdempotency.get(key) ?? this.#idempotencyResults.get(key),
      putIdempotency: (key, value) => {
        pendingIdempotency.set(key, value);
      },
      findExclusive: (subject, group) => this.#exclusiveCommits.get(exclusiveKey(subject, group)),
      append: (event, exclusiveGroup) => {
        if (pendingAppend !== undefined) {
          throw new Error("A room transaction may append at most one event.");
        }
        pendingAppend = { event, exclusiveGroup };
      },
    };

    const result = work(transaction);

    // Validate every staged mutation before applying any of them.
    if (pendingAppend !== undefined) {
      if (pendingAppend.event.sequence !== this.headSequence + 1) {
        throw new Error("Event sequence no longer follows the room head.");
      }
      if (pendingAppend.event.subjectVersion !== this.currentVersion(pendingAppend.event.subject) + 1) {
        throw new Error("Event subject version no longer follows the subject head.");
      }
      if (
        pendingAppend.exclusiveGroup !== undefined &&
        this.#exclusiveCommits.has(exclusiveKey(pendingAppend.event.subject, pendingAppend.exclusiveGroup))
      ) {
        throw new Error("Exclusive slot was occupied before the transaction committed.");
      }
    }

    if (pendingAppend !== undefined) {
      const { event, exclusiveGroup } = pendingAppend;
      this.#events.push(event);
      const key = subjectKey(event.subject);
      const subjectEvents = this.#eventsBySubject.get(key) ?? [];
      subjectEvents.push(event);
      this.#eventsBySubject.set(key, subjectEvents);
      this.#versions.set(key, event.subjectVersion);
      if (exclusiveGroup !== undefined) {
        this.#exclusiveCommits.set(exclusiveKey(event.subject, exclusiveGroup), event);
      }
    }
    for (const [key, value] of pendingIdempotency) {
      this.#idempotencyResults.set(key, value);
    }

    return result;
  }

  readEvents(query: EventQuery = {}): readonly RoomEvent[] {
    const { afterSequence, limit } = normalizeQuery(query);
    return Object.freeze(this.#events.slice(afterSequence, afterSequence + limit));
  }

  snapshot(subject: SubjectRef): SubjectSnapshot {
    return Object.freeze({
      subject: Object.freeze({ ...subject }),
      version: this.currentVersion(subject),
      events: Object.freeze([...(this.#eventsBySubject.get(subjectKey(subject)) ?? [])]),
    });
  }

  currentVersion(subject: SubjectRef): number {
    return this.#versions.get(subjectKey(subject)) ?? 0;
  }
}

export function normalizeQuery(query: EventQuery): { readonly afterSequence: number; readonly limit: number } {
  const afterSequence = query.afterSequence ?? 0;
  const limit = query.limit ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new RangeError("afterSequence must be a non-negative integer.");
  }
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError("limit must be non-negative.");
  }
  return { afterSequence, limit: limit === 0 ? 0 : limit };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateBases(
  transaction: RoomBackendTransaction,
  bases: readonly CausalBasis[],
): { readonly status: "valid" } | { readonly status: "invalid"; readonly result: Rejected | NeedsRebase } {
  const conflicts: SubjectConflict[] = [];

  for (const basis of bases) {
    const currentVersion = transaction.currentVersion(basis.subject);
    if (!Number.isInteger(basis.version) || basis.version < 0 || basis.version > currentVersion) {
      return {
        status: "invalid",
        result: reject(
          "invalid_basis",
          `Basis ${subjectKey(basis.subject)}@${basis.version} is not valid at version ${currentVersion}.`,
          { currentVersion },
        ),
      };
    }

    if (basis.version < currentVersion) {
      conflicts.push(
        deepFreeze({
          subject: { ...basis.subject },
          expectedVersion: basis.version,
          currentVersion,
          changesSinceBasis: [...transaction.readSubjectEventsAfter(basis.subject, basis.version)],
        }),
      );
    }
  }

  if (conflicts.length > 0) {
    return {
      status: "invalid",
      result: deepFreeze({ status: "needs_rebase", conflicts }),
    };
  }

  return { status: "valid" };
}

function normalizeBases(bases: readonly CausalBasis[] | undefined): readonly CausalBasis[] | Error {
  const normalized: CausalBasis[] = [];
  const seen = new Map<string, number>();

  for (const basis of bases ?? []) {
    const key = subjectKey(basis.subject);
    const priorVersion = seen.get(key);
    if (priorVersion !== undefined && priorVersion !== basis.version) {
      return new Error(`Conflicting basis versions supplied for ${key}.`);
    }
    if (priorVersion === undefined) {
      seen.set(key, basis.version);
      normalized.push(deepFreeze(cloneBasis(basis)));
    }
  }

  return Object.freeze(normalized);
}

function cloneBasis(basis: CausalBasis): CausalBasis {
  return { subject: { ...basis.subject }, version: basis.version };
}

function replayResult(result: CommitResult): CommitResult {
  if (result.status !== "committed") {
    return result;
  }
  return Object.freeze({ ...result, replayed: true });
}

function reject(
  code: Rejected["code"],
  message: string,
  details: Pick<Rejected, "currentVersion" | "conflictingEvent"> = {},
): Rejected {
  return deepFreeze({ status: "rejected", code, message, ...details });
}

function exclusiveKey(subject: SubjectRef, group: string): string {
  return `${subjectKey(subject)}::${group}`;
}

function canonicalStringify(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) {
    throw new TypeError("Intent must be serializable.");
  }
  return encoded;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
