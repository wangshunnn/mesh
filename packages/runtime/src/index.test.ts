import assert from "node:assert/strict";
import test from "node:test";

import { CoreAction, type Intent, type SubjectRef } from "@ai-mesh/protocol";
import { InMemoryRoomLedger } from "@ai-mesh/room";

import { InMemoryCursorStore, ParticipantInbox } from "./index.js";

const roomId = "room:test";
const general: SubjectRef = { kind: "thread", id: "general" };
const privateThread: SubjectRef = { kind: "thread", id: "private" };

function append(ledger: InMemoryRoomLedger, id: string, subject = general): void {
  const value: Intent = {
    id,
    idempotencyKey: id,
    roomId,
    actorId: "human",
    subject,
    action: CoreAction.threadMessageAppend,
    payload: { text: id },
  };
  assert.equal(ledger.commit(value).status, "committed");
}

test("an inbox resumes after its acknowledged cursor", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const cursors = new InMemoryCursorStore();
  const inbox = new ParticipantInbox(ledger, cursors, "agent:a");

  append(ledger, "event:1");
  append(ledger, "event:2");
  const first = inbox.pull({ limit: 1 });
  assert.deepEqual(first.events.map((event) => event.sequence), [1]);
  inbox.acknowledge(first);

  append(ledger, "event:3");
  const resumed = new ParticipantInbox(ledger, cursors, "agent:a");
  const second = resumed.pull();
  assert.deepEqual(second.events.map((event) => event.sequence), [2, 3]);
  resumed.acknowledge(second);
  assert.equal(resumed.cursor, 3);
});

test("filtered events are scanned and do not reappear", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const cursors = new InMemoryCursorStore();
  const inbox = new ParticipantInbox(ledger, cursors, "agent:a", {
    filter: (event) => event.subject.id === "general",
  });

  append(ledger, "private:1", privateThread);
  append(ledger, "general:1", general);
  const batch = inbox.pull({ limit: 1 });
  assert.deepEqual(batch.events.map((event) => event.sequence), [2]);
  assert.equal(batch.scannedThrough, 2);
  inbox.acknowledge(batch);
  assert.equal(inbox.pull().events.length, 0);
});

test("an unacknowledged batch is delivered again", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const inbox = new ParticipantInbox(ledger, new InMemoryCursorStore(), "agent:a");
  append(ledger, "event:1");

  assert.deepEqual(inbox.pull().events.map((event) => event.sequence), [1]);
  assert.deepEqual(inbox.pull().events.map((event) => event.sequence), [1]);
});

test("wake hints contain only the room head and missed hints do not lose events", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const inbox = new ParticipantInbox(ledger, new InMemoryCursorStore(), "agent:a");
  const heads: number[] = [];
  const unsubscribe = inbox.subscribeToWakeHints((hint) => {
    heads.push(hint.headSequence);
    assert.deepEqual(Object.keys(hint).sort(), [
      "headSequence",
      "participantId",
      "roomId",
      "subscriptionId",
    ]);
  });

  append(ledger, "event:1");
  unsubscribe();
  append(ledger, "event:2");

  assert.deepEqual(heads, [1]);
  assert.deepEqual(inbox.pull().events.map((event) => event.sequence), [1, 2]);
});

test("stale batches cannot advance a cursor out of order", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const inbox = new ParticipantInbox(ledger, new InMemoryCursorStore(), "agent:a");
  append(ledger, "event:1");
  const first = inbox.pull();
  const duplicate = inbox.pull();
  inbox.acknowledge(first);

  assert.throws(() => inbox.acknowledge(duplicate), /current cursor is 1/);
});
