import assert from "node:assert/strict";
import test from "node:test";

import { CoreAction, type Intent, type SubjectRef } from "@ai-mesh/protocol";

import { InMemoryRoomLedger } from "./index.js";

const roomId = "room:test";
const thread: SubjectRef = { kind: "thread", id: "general" };

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: "intent:1",
    idempotencyKey: "key:1",
    roomId,
    actorId: "agent:a",
    subject: thread,
    action: CoreAction.threadMessageAppend,
    payload: { text: "hello" },
    ...overrides,
  };
}

test("append actions do not require a causal basis", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const result = ledger.commit(intent());

  assert.equal(result.status, "committed");
  assert.equal(ledger.currentVersion(thread), 1);
  assert.equal(ledger.headSequence, 1);
});

test("compare-and-append returns only relevant subject changes", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  ledger.commit(intent());

  const result = ledger.commit(
    intent({
      id: "intent:2",
      idempotencyKey: "key:2",
      actorId: "agent:b",
      action: CoreAction.threadReplyCommit,
      payload: { text: "stale" },
      basedOn: [{ subject: thread, version: 0 }],
    }),
  );

  assert.equal(result.status, "needs_rebase");
  if (result.status === "needs_rebase") {
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.currentVersion, 1);
    assert.equal(result.conflicts[0]?.changesSinceBasis.length, 1);
  }
});

test("idempotent retries replay the committed event", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  const first = ledger.commit(intent());
  const retry = ledger.commit(intent());

  assert.equal(first.status, "committed");
  assert.equal(retry.status, "committed");
  if (first.status === "committed" && retry.status === "committed") {
    assert.equal(retry.event.id, first.event.id);
    assert.equal(retry.replayed, true);
  }
  assert.equal(ledger.headSequence, 1);
});

test("reusing an idempotency key for another intent is rejected", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  ledger.commit(intent());
  const result = ledger.commit(intent({ payload: { text: "different" } }));

  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    assert.equal(result.code, "idempotency_conflict");
  }
  assert.equal(ledger.headSequence, 1);
});

test("exclusive policies allow exactly one commit per subject and group", () => {
  const task: SubjectRef = { kind: "task", id: "12" };
  const ledger = new InMemoryRoomLedger(roomId);
  const created = ledger.commit(
    intent({
      id: "create",
      idempotencyKey: "create",
      subject: task,
      action: CoreAction.taskCreate,
      payload: { title: "Task" },
    }),
  );
  assert.equal(created.status, "committed");

  const basis = [{ subject: task, version: 1 }];
  const first = ledger.commit(
    intent({
      id: "claim:a",
      idempotencyKey: "claim:a",
      subject: task,
      action: CoreAction.taskClaim,
      payload: { ownerId: "agent:a" },
      basedOn: basis,
    }),
  );
  const second = ledger.commit(
    intent({
      id: "claim:b",
      idempotencyKey: "claim:b",
      actorId: "agent:b",
      subject: task,
      action: CoreAction.taskClaim,
      payload: { ownerId: "agent:b" },
      basedOn: basis,
    }),
  );

  assert.equal(first.status, "committed");
  assert.equal(second.status, "rejected");
  if (second.status === "rejected") {
    assert.equal(second.code, "already_claimed");
  }
});

test("task claims and updates require a previously created task", () => {
  const room = new InMemoryRoomLedger("room:test");
  const task: SubjectRef = { kind: "task", id: "missing" };

  const claim = room.commit({
    id: "claim-missing",
    idempotencyKey: "claim-missing",
    roomId: room.roomId,
    actorId: "agent:a",
    subject: task,
    action: CoreAction.taskClaim,
    payload: { ownerId: "agent:a" },
    basedOn: [{ subject: task, version: 0 }],
  });
  const update = room.commit({
    id: "update-missing",
    idempotencyKey: "update-missing",
    roomId: room.roomId,
    actorId: "agent:a",
    subject: task,
    action: CoreAction.taskUpdate,
    payload: { status: "done" },
    basedOn: [{ subject: task, version: 0 }],
  });

  assert.equal(claim.status, "rejected");
  assert.equal(update.status, "rejected");
  if (claim.status === "rejected" && update.status === "rejected") {
    assert.equal(claim.code, "not_found");
    assert.equal(update.code, "not_found");
  }
  assert.equal(room.headSequence, 0);
});

test("listener failures cannot fail or roll back a commit", () => {
  const ledger = new InMemoryRoomLedger(roomId);
  ledger.subscribe(() => {
    throw new Error("observer failed");
  });

  assert.equal(ledger.commit(intent()).status, "committed");
  assert.equal(ledger.headSequence, 1);
});
