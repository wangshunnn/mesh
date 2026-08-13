import type { ParticipantId, RoomEvent, RoomId } from "@ai-mesh/protocol";
import type { RoomLedger, Unsubscribe } from "@ai-mesh/room";

export interface CursorKey {
  readonly roomId: RoomId;
  readonly participantId: ParticipantId;
  readonly subscriptionId: string;
}

export interface CursorStore {
  load(key: CursorKey): number;
  advance(key: CursorKey, sequence: number): void;
}

export class InMemoryCursorStore implements CursorStore {
  readonly #cursors = new Map<string, number>();

  load(key: CursorKey): number {
    return this.#cursors.get(cursorKey(key)) ?? 0;
  }

  advance(key: CursorKey, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new RangeError("Cursor sequence must be a non-negative integer.");
    }
    const stored = this.load(key);
    if (sequence < stored) {
      throw new RangeError(`Cursor cannot move backwards from ${stored} to ${sequence}.`);
    }
    this.#cursors.set(cursorKey(key), sequence);
  }
}

export type EventFilter = (event: RoomEvent) => boolean;

export interface InboxOptions {
  readonly subscriptionId?: string;
  readonly filter?: EventFilter;
}

export interface InboxBatch {
  readonly afterCursor: number;
  readonly scannedThrough: number;
  readonly roomHead: number;
  readonly events: readonly RoomEvent[];
}

export interface WakeHint {
  readonly roomId: RoomId;
  readonly participantId: ParticipantId;
  readonly subscriptionId: string;
  readonly headSequence: number;
}

export type WakeListener = (hint: WakeHint) => void;

/**
 * A durable logical inbox over the canonical room log.
 *
 * Wake hints contain no event body and are deliberately lossy. Correctness comes
 * from pulling every event after the stored cursor. A participant acknowledges a
 * scanned range only after it has safely processed the returned batch.
 */
export class ParticipantInbox {
  readonly participantId: ParticipantId;
  readonly subscriptionId: string;

  readonly #ledger: RoomLedger;
  readonly #cursorStore: CursorStore;
  readonly #cursorKey: CursorKey;
  readonly #filter: EventFilter;

  constructor(
    ledger: RoomLedger,
    cursorStore: CursorStore,
    participantId: ParticipantId,
    options: InboxOptions = {},
  ) {
    this.#ledger = ledger;
    this.#cursorStore = cursorStore;
    this.participantId = participantId;
    this.subscriptionId = options.subscriptionId ?? "room";
    this.#filter = options.filter ?? (() => true);
    this.#cursorKey = Object.freeze({
      roomId: ledger.roomId,
      participantId,
      subscriptionId: this.subscriptionId,
    });
  }

  get cursor(): number {
    return this.#cursorStore.load(this.#cursorKey);
  }

  pull(options: { readonly limit?: number } = {}): InboxBatch {
    const afterCursor = this.cursor;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (!(limit > 0)) {
      return Object.freeze({
        afterCursor,
        scannedThrough: afterCursor,
        roomHead: this.#ledger.headSequence,
        events: Object.freeze([]),
      });
    }

    // Limit applies to delivered events, not scanned events. Filtered activity can
    // therefore be acknowledged without repeatedly rescanning it on every pull.
    const delivered: RoomEvent[] = [];
    let scannedThrough = afterCursor;
    const available = this.#ledger.readEvents({ afterSequence: afterCursor });
    for (const event of available) {
      scannedThrough = event.sequence;
      if (this.#filter(event)) {
        delivered.push(event);
        if (delivered.length >= limit) {
          break;
        }
      }
    }

    return Object.freeze({
      afterCursor,
      scannedThrough,
      roomHead: this.#ledger.headSequence,
      events: Object.freeze(delivered),
    });
  }

  acknowledge(batch: InboxBatch): void {
    const current = this.cursor;
    if (batch.afterCursor !== current) {
      throw new Error(
        `Cannot acknowledge a batch starting at ${batch.afterCursor}; current cursor is ${current}.`,
      );
    }
    if (batch.scannedThrough > this.#ledger.headSequence) {
      throw new Error("Cannot acknowledge beyond the room head.");
    }
    this.#cursorStore.advance(this.#cursorKey, batch.scannedThrough);
  }

  subscribeToWakeHints(listener: WakeListener): Unsubscribe {
    return this.#ledger.subscribe((notification) => {
      if (notification.headSequence <= this.cursor) {
        return;
      }
      listener(
        Object.freeze({
          roomId: this.#ledger.roomId,
          participantId: this.participantId,
          subscriptionId: this.subscriptionId,
          headSequence: notification.headSequence,
        }),
      );
    });
  }
}

function cursorKey(key: CursorKey): string {
  return `${key.roomId}\u0000${key.participantId}\u0000${key.subscriptionId}`;
}
