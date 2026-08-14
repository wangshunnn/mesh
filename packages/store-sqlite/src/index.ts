import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import {
  subjectKey,
  type CommitResult,
  type RoomEvent,
  type RoomId,
  type SubjectRef,
  type TraceJournal,
  type TraceRecord,
  type TraceRecordInput,
} from "@ai-mesh/protocol";
import {
  PolicyRoomLedger,
  deepFreeze,
  normalizeQuery,
  type EventQuery,
  type PolicyRoomLedgerOptions,
  type RoomBackend,
  type RoomBackendTransaction,
  type RoomLedger,
  type StoredIdempotencyResult,
  type SubjectSnapshot,
} from "@ai-mesh/room";
import type { CursorKey, CursorStore } from "@ai-mesh/runtime";

const schemaVersion = 2;

export interface SqliteStoreOptions {
  readonly createDirectory?: boolean;
}

/**
 * Owns one SQLite connection shared by room ledgers and participant cursors.
 * Call close() after every consumer using this store has stopped.
 */
export class SqliteStore {
  readonly #database: DatabaseSync;
  readonly #backendCache = new Map<RoomId, SqliteRoomBackend>();
  #closed = false;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    if (path !== ":memory:" && options.createDirectory !== false) {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  room(roomId: RoomId, options: PolicyRoomLedgerOptions = {}): RoomLedger {
    this.#assertOpen();
    let backend = this.#backendCache.get(roomId);
    if (backend === undefined) {
      backend = new SqliteRoomBackend(this.#database, roomId);
      this.#backendCache.set(roomId, backend);
    }
    return new PolicyRoomLedger(backend, options);
  }

  cursors(): CursorStore {
    this.#assertOpen();
    return new SqliteCursorStore(this.#database, () => this.#assertOpen());
  }

  traces(roomId: RoomId): TraceJournal {
    this.#assertOpen();
    return new SqliteTraceJournal(this.#database, roomId, () => this.#assertOpen());
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#database.close();
    this.#closed = true;
    this.#backendCache.clear();
  }

  #migrate(): void {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS mesh_schema (
          version INTEGER PRIMARY KEY
        ) STRICT;

        CREATE TABLE IF NOT EXISTS room_events (
          room_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          subject_version INTEGER NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          caused_by_json TEXT NOT NULL,
          committed_at INTEGER NOT NULL,
          PRIMARY KEY (room_id, sequence),
          UNIQUE (room_id, event_id),
          UNIQUE (room_id, subject_kind, subject_id, subject_version)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS room_events_by_subject
          ON room_events (room_id, subject_kind, subject_id, subject_version);

        CREATE TABLE IF NOT EXISTS room_subjects (
          room_id TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          PRIMARY KEY (room_id, subject_kind, subject_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS room_exclusive_slots (
          room_id TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          slot_group TEXT NOT NULL,
          event_sequence INTEGER NOT NULL,
          PRIMARY KEY (room_id, subject_kind, subject_id, slot_group),
          FOREIGN KEY (room_id, event_sequence)
            REFERENCES room_events (room_id, sequence)
            ON DELETE RESTRICT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS room_idempotency (
          room_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (room_id, idempotency_key)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS participant_cursors (
          room_id TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          PRIMARY KEY (room_id, participant_id, subscription_id)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS runtime_traces (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE (room_id, trace_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS runtime_traces_by_room
          ON runtime_traces (room_id, sequence);
      `);

      const version = this.#database.prepare("SELECT MAX(version) AS version FROM mesh_schema").get();
      const currentVersion = readOptionalNumber(version, "version") ?? 0;
      if (currentVersion > schemaVersion) {
        throw new Error(
          `Mesh database schema ${currentVersion} is newer than supported schema ${schemaVersion}.`,
        );
      }
      if (currentVersion < schemaVersion) {
        this.#database.prepare("INSERT INTO mesh_schema (version) VALUES (?)").run(schemaVersion);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SQLite store is closed.");
    }
  }
}

class SqliteRoomBackend implements RoomBackend {
  readonly roomId: RoomId;
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync, roomId: RoomId) {
    this.#database = database;
    this.roomId = roomId;
  }

  get headSequence(): number {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_events WHERE room_id = ?")
      .get(this.roomId);
    return readNumber(row, "sequence");
  }

  transaction<T>(work: (transaction: RoomBackendTransaction) => T): T {
    if (this.#database.isTransaction) {
      throw new Error("Nested Room transactions are not supported.");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const transaction = new SqliteRoomTransaction(this.#database, this.roomId);
      const result = work(transaction);
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  readEvents(query: EventQuery = {}): readonly RoomEvent[] {
    const { afterSequence, limit } = normalizeQuery(query);
    if (limit === 0) {
      return Object.freeze([]);
    }
    const effectiveLimit = Number.isFinite(limit) ? limit : -1;
    const rows = this.#database
      .prepare(
        `SELECT * FROM room_events
         WHERE room_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(this.roomId, afterSequence, effectiveLimit);
    return Object.freeze(rows.map(rowToEvent));
  }

  snapshot(subject: SubjectRef): SubjectSnapshot {
    const rows = this.#database
      .prepare(
        `SELECT * FROM room_events
         WHERE room_id = ? AND subject_kind = ? AND subject_id = ?
         ORDER BY subject_version ASC`,
      )
      .all(this.roomId, subject.kind, subject.id);
    return Object.freeze({
      subject: Object.freeze({ ...subject }),
      version: this.currentVersion(subject),
      events: Object.freeze(rows.map(rowToEvent)),
    });
  }

  currentVersion(subject: SubjectRef): number {
    const row = this.#database
      .prepare(
        `SELECT version FROM room_subjects
         WHERE room_id = ? AND subject_kind = ? AND subject_id = ?`,
      )
      .get(this.roomId, subject.kind, subject.id);
    return readOptionalNumber(row, "version") ?? 0;
  }
}

class SqliteRoomTransaction implements RoomBackendTransaction {
  readonly #database: DatabaseSync;
  readonly #roomId: RoomId;
  readonly headSequence: number;
  #appendCount = 0;

  constructor(database: DatabaseSync, roomId: RoomId) {
    this.#database = database;
    this.#roomId = roomId;
    const row = database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_events WHERE room_id = ?")
      .get(roomId);
    this.headSequence = readNumber(row, "sequence");
  }

  currentVersion(subject: SubjectRef): number {
    const row = this.#database
      .prepare(
        `SELECT version FROM room_subjects
         WHERE room_id = ? AND subject_kind = ? AND subject_id = ?`,
      )
      .get(this.#roomId, subject.kind, subject.id);
    return readOptionalNumber(row, "version") ?? 0;
  }

  readSubjectEventsAfter(subject: SubjectRef, version: number): readonly RoomEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM room_events
         WHERE room_id = ? AND subject_kind = ? AND subject_id = ? AND subject_version > ?
         ORDER BY subject_version ASC`,
      )
      .all(this.#roomId, subject.kind, subject.id, version);
    return Object.freeze(rows.map(rowToEvent));
  }

  getIdempotency(key: string): StoredIdempotencyResult | undefined {
    const row = this.#database
      .prepare(
        `SELECT fingerprint, result_json FROM room_idempotency
         WHERE room_id = ? AND idempotency_key = ?`,
      )
      .get(this.#roomId, key);
    if (row === undefined) {
      return undefined;
    }
    return Object.freeze({
      fingerprint: readString(row, "fingerprint"),
      result: parseJson<CommitResult>(readString(row, "result_json")),
    });
  }

  putIdempotency(key: string, value: StoredIdempotencyResult): void {
    this.#database
      .prepare(
        `INSERT INTO room_idempotency
           (room_id, idempotency_key, fingerprint, result_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(this.#roomId, key, value.fingerprint, stringifyJson(value.result));
  }

  findExclusive(subject: SubjectRef, group: string): RoomEvent | undefined {
    const row = this.#database
      .prepare(
        `SELECT event.*
         FROM room_exclusive_slots AS slot
         JOIN room_events AS event
           ON event.room_id = slot.room_id AND event.sequence = slot.event_sequence
         WHERE slot.room_id = ? AND slot.subject_kind = ?
           AND slot.subject_id = ? AND slot.slot_group = ?`,
      )
      .get(this.#roomId, subject.kind, subject.id, group);
    return row === undefined ? undefined : rowToEvent(row);
  }

  append(event: RoomEvent, exclusiveGroup: string | undefined): void {
    if (this.#appendCount > 0) {
      throw new Error("A room transaction may append at most one event.");
    }
    if (event.sequence !== this.headSequence + 1) {
      throw new Error("Event sequence no longer follows the room head.");
    }
    if (event.subjectVersion !== this.currentVersion(event.subject) + 1) {
      throw new Error("Event subject version no longer follows the subject head.");
    }

    this.#database
      .prepare(
        `INSERT INTO room_events (
           room_id, sequence, event_id, actor_id, subject_kind, subject_id,
           subject_version, action, payload_json, intent_id, idempotency_key,
           caused_by_json, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.roomId,
        event.sequence,
        event.id,
        event.actorId,
        event.subject.kind,
        event.subject.id,
        event.subjectVersion,
        event.action,
        stringifyJson(event.payload),
        event.intentId,
        event.idempotencyKey,
        stringifyJson(event.causedBy),
        event.committedAt,
      );
    this.#database
      .prepare(
        `INSERT INTO room_subjects (room_id, subject_kind, subject_id, version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, subject_kind, subject_id)
         DO UPDATE SET version = excluded.version`,
      )
      .run(event.roomId, event.subject.kind, event.subject.id, event.subjectVersion);
    if (exclusiveGroup !== undefined) {
      this.#database
        .prepare(
          `INSERT INTO room_exclusive_slots
             (room_id, subject_kind, subject_id, slot_group, event_sequence)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(event.roomId, event.subject.kind, event.subject.id, exclusiveGroup, event.sequence);
    }
    this.#appendCount += 1;
  }
}

class SqliteCursorStore implements CursorStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;

  constructor(database: DatabaseSync, assertOpen: () => void) {
    this.#database = database;
    this.#assertOpen = assertOpen;
  }

  load(key: CursorKey): number {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT sequence FROM participant_cursors
         WHERE room_id = ? AND participant_id = ? AND subscription_id = ?`,
      )
      .get(key.roomId, key.participantId, key.subscriptionId);
    return readOptionalNumber(row, "sequence") ?? 0;
  }

  advance(key: CursorKey, sequence: number): void {
    this.#assertOpen();
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new RangeError("Cursor sequence must be a non-negative integer.");
    }
    const result = this.#database
      .prepare(
        `INSERT INTO participant_cursors
           (room_id, participant_id, subscription_id, sequence)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, participant_id, subscription_id)
         DO UPDATE SET sequence = excluded.sequence
         WHERE excluded.sequence >= participant_cursors.sequence`,
      )
      .run(key.roomId, key.participantId, key.subscriptionId, sequence);
    if (result.changes === 0) {
      throw new RangeError(`Cursor cannot move backwards from ${this.load(key)} to ${sequence}.`);
    }
  }
}

class SqliteTraceJournal implements TraceJournal {
  readonly #database: DatabaseSync;
  readonly #roomId: RoomId;
  readonly #assertOpen: () => void;

  constructor(database: DatabaseSync, roomId: RoomId, assertOpen: () => void) {
    this.#database = database;
    this.#roomId = roomId;
    this.#assertOpen = assertOpen;
  }

  append(input: TraceRecordInput): TraceRecord {
    this.#assertOpen();
    if (input.roomId !== this.#roomId) {
      throw new Error(`Trace ${input.id} belongs to ${input.roomId}, not ${this.#roomId}.`);
    }
    const payload = {
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.data === undefined ? {} : { data: input.data }),
    };
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO runtime_traces
           (room_id, trace_id, actor_id, kind, status, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roomId,
        input.id,
        input.actorId,
        input.kind,
        input.status,
        input.occurredAt,
        stringifyJson(payload),
      );
    const stored = this.#database
      .prepare("SELECT * FROM runtime_traces WHERE room_id = ? AND trace_id = ?")
      .get(this.#roomId, input.id);
    if (stored === undefined) {
      throw new Error(`Trace ${input.id} could not be persisted.`);
    }
    return rowToTrace(stored);
  }

  read(): readonly TraceRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare("SELECT * FROM runtime_traces WHERE room_id = ? ORDER BY sequence ASC")
      .all(this.#roomId);
    return Object.freeze(rows.map(rowToTrace));
  }
}

function rowToEvent(row: Record<string, SQLOutputValue>): RoomEvent {
  return deepFreeze({
    id: readString(row, "event_id"),
    sequence: readNumber(row, "sequence"),
    roomId: readString(row, "room_id"),
    actorId: readString(row, "actor_id"),
    subject: {
      kind: readString(row, "subject_kind") as SubjectRef["kind"],
      id: readString(row, "subject_id"),
    },
    subjectVersion: readNumber(row, "subject_version"),
    action: readString(row, "action"),
    payload: parseJson<unknown>(readString(row, "payload_json")),
    intentId: readString(row, "intent_id"),
    idempotencyKey: readString(row, "idempotency_key"),
    causedBy: parseJson<RoomEvent["causedBy"]>(readString(row, "caused_by_json")),
    committedAt: readNumber(row, "committed_at"),
  });
}

function rowToTrace(row: Record<string, SQLOutputValue>): TraceRecord {
  const payload = parseJson<{
    readonly correlationId?: string;
    readonly turnId?: string;
    readonly attempt?: number;
    readonly content?: string;
    readonly detail?: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }>(readString(row, "payload_json"));
  return deepFreeze({
    id: readString(row, "trace_id"),
    sequence: readNumber(row, "sequence"),
    roomId: readString(row, "room_id"),
    actorId: readString(row, "actor_id"),
    kind: readString(row, "kind"),
    status: readString(row, "status") as TraceRecord["status"],
    occurredAt: readNumber(row, "occurred_at"),
    ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    ...(payload.turnId === undefined ? {} : { turnId: payload.turnId }),
    ...(payload.attempt === undefined ? {} : { attempt: payload.attempt }),
    ...(payload.content === undefined ? {} : { content: payload.content }),
    ...(payload.detail === undefined ? {} : { detail: payload.detail }),
    ...(payload.data === undefined ? {} : { data: payload.data }),
  });
}

function readString(row: Record<string, SQLOutputValue> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new TypeError(`Expected SQLite column ${key} to be a string.`);
  }
  return value;
}

function readNumber(row: Record<string, SQLOutputValue> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`Expected SQLite column ${key} to be a safe integer.`);
  }
  return value;
}

function readOptionalNumber(
  row: Record<string, SQLOutputValue> | undefined,
  key: string,
): number | undefined {
  const value = row?.[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`Expected SQLite column ${key} to be a safe integer or null.`);
  }
  return value;
}

function parseJson<T>(value: string): T {
  return deepFreeze(JSON.parse(value) as T);
}

function stringifyJson(value: unknown): SQLInputValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Room data must be JSON serializable.");
  }
  return encoded;
}

export function debugSubjectKey(subject: SubjectRef): string {
  return subjectKey(subject);
}
