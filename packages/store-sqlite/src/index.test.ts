import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreAction, type Intent, type SubjectRef } from "@ai-mesh/protocol";
import { ParticipantInbox } from "@ai-mesh/runtime";

import { SqliteStore } from "./index.js";

const roomId = "room:persistent";
const thread: SubjectRef = { kind: "thread", id: "general" };

function message(id: string): Intent {
  return {
    id,
    idempotencyKey: id,
    roomId,
    actorId: "human",
    subject: thread,
    action: CoreAction.threadMessageAppend,
    payload: { text: id },
  };
}

test("events, subject versions, idempotency, and cursors survive reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-sqlite-"));
  const path = join(directory, "mesh.db");

  const firstStore = new SqliteStore(path);
  const firstRoom = firstStore.room(roomId);
  const firstResult = firstRoom.commit(message("message:1"));
  assert.equal(firstResult.status, "committed");
  const inbox = new ParticipantInbox(firstRoom, firstStore.cursors(), "agent:a");
  const firstBatch = inbox.pull();
  inbox.acknowledge(firstBatch);
  assert.equal(inbox.cursor, 1);
  firstStore.close();

  const reopenedStore = new SqliteStore(path);
  const reopenedRoom = reopenedStore.room(roomId);
  assert.equal(reopenedRoom.headSequence, 1);
  assert.equal(reopenedRoom.currentVersion(thread), 1);
  assert.equal(reopenedRoom.snapshot(thread).events[0]?.payload instanceof Object, true);
  const retry = reopenedRoom.commit(message("message:1"));
  assert.equal(retry.status, "committed");
  if (firstResult.status === "committed" && retry.status === "committed") {
    assert.equal(retry.event.id, firstResult.event.id);
    assert.equal(retry.replayed, true);
  }
  const reopenedInbox = new ParticipantInbox(reopenedRoom, reopenedStore.cursors(), "agent:a");
  assert.equal(reopenedInbox.cursor, 1);
  assert.equal(reopenedInbox.pull().events.length, 0);
  reopenedStore.close();
});

test("exclusive task claims remain exclusive after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-sqlite-"));
  const path = join(directory, "mesh.db");
  const task: SubjectRef = { kind: "task", id: "12" };
  const firstStore = new SqliteStore(path);
  const room = firstStore.room(roomId);
  assert.equal(
    room.commit({
      id: "create",
      idempotencyKey: "create",
      roomId,
      actorId: "human",
      subject: task,
      action: CoreAction.taskCreate,
      payload: { title: "Task" },
    }).status,
    "committed",
  );
  assert.equal(
    room.commit({
      id: "claim:a",
      idempotencyKey: "claim:a",
      roomId,
      actorId: "agent:a",
      subject: task,
      action: CoreAction.taskClaim,
      payload: { ownerId: "agent:a" },
      basedOn: [{ subject: task, version: 1 }],
    }).status,
    "committed",
  );
  firstStore.close();

  const reopenedStore = new SqliteStore(path);
  const second = reopenedStore.room(roomId).commit({
    id: "claim:b",
    idempotencyKey: "claim:b",
    roomId,
    actorId: "agent:b",
    subject: task,
    action: CoreAction.taskClaim,
    payload: { ownerId: "agent:b" },
    basedOn: [{ subject: task, version: 2 }],
  });
  assert.equal(second.status, "rejected");
  if (second.status === "rejected") {
    assert.equal(second.code, "already_claimed");
  }
  reopenedStore.close();
});

test("a rejected result is durably idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-sqlite-"));
  const path = join(directory, "mesh.db");
  const store = new SqliteStore(path);
  const room = store.room(roomId);
  const stale: Intent = {
    id: "missing-basis",
    idempotencyKey: "missing-basis",
    roomId,
    actorId: "agent:a",
    subject: thread,
    action: CoreAction.threadReplyCommit,
    payload: { text: "reply" },
  };
  const first = room.commit(stale);
  assert.equal(first.status, "rejected");
  store.close();

  const reopened = new SqliteStore(path);
  const retry = reopened.room(roomId).commit(stale);
  assert.deepEqual(retry, first);
  reopened.close();
});

test("cursor cannot move backwards in SQLite", () => {
  const store = new SqliteStore(":memory:");
  const cursors = store.cursors();
  const key = { roomId, participantId: "agent:a", subscriptionId: "room" };
  cursors.advance(key, 5);
  assert.throws(() => cursors.advance(key, 4), /cannot move backwards/);
  assert.equal(cursors.load(key), 5);
  store.close();
});
