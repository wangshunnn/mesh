import { CoreAction, type CommitResult, type Intent, type RoomEvent, type SubjectRef } from "@ai-mesh/protocol";
import { InMemoryRoomLedger } from "@ai-mesh/room";
import { InMemoryCursorStore, ParticipantInbox } from "@ai-mesh/runtime";

export interface EvaluationReport {
  readonly name: string;
  readonly passed: boolean;
  readonly metrics: Readonly<Record<string, string | number | boolean>>;
  readonly failure?: string;
}

export interface CountingEvaluationOptions {
  readonly participants?: number;
  readonly thinkDelay?: (participantIndex: number, attempt: number) => Promise<void>;
}

interface CountPayload {
  readonly kind: "count";
  readonly value: number;
}

const roomId = "room:eval";

/**
 * Runs independent participant loops; there is deliberately no speaker queue,
 * turn allocator, atomic increment, or coordinator choosing a winner.
 */
export async function runCountingEvaluation(
  options: CountingEvaluationOptions = {},
): Promise<EvaluationReport> {
  const participants = options.participants ?? 10;
  if (!Number.isInteger(participants) || participants < 1) {
    throw new RangeError("participants must be a positive integer.");
  }

  const thinkDelay = options.thinkDelay ?? deterministicThinkDelay;
  const thread: SubjectRef = { kind: "thread", id: "counting" };
  const ledger = new InMemoryRoomLedger(roomId);
  const cursorStore = new InMemoryCursorStore();
  let staleIntentsRebased = 0;

  requireCommitted(
    ledger.commit({
      id: "counting:command",
      idempotencyKey: "counting:command",
      roomId,
      actorId: "human",
      subject: thread,
      action: CoreAction.threadMessageAppend,
      payload: { kind: "command", text: "报数！" },
    }),
  );

  const participantLoops = Array.from({ length: participants }, (_, index) => {
    const participantId = `agent:${index + 1}`;
    const inbox = new ParticipantInbox(ledger, cursorStore, participantId, {
      subscriptionId: "counting-thread",
      filter: (event) => sameRef(event.subject, thread),
    });
    const localEvents: RoomEvent[] = [];

    return async (): Promise<void> => {
      for (let attempt = 1; attempt <= participants * 4; attempt += 1) {
        const batch = inbox.pull();
        localEvents.push(...batch.events);
        inbox.acknowledge(batch);

        if (localEvents.some((event) => event.actorId === participantId && isCountEvent(event))) {
          return;
        }

        const lastEvent = localEvents.at(-1);
        const observedVersion = lastEvent?.subjectVersion ?? 0;
        const lastCount = localEvents.reduce(
          (highest, event) => (isCountEvent(event) ? Math.max(highest, event.payload.value) : highest),
          0,
        );

        // This yield represents the real reasoning window in which the room can move.
        await thinkDelay(index, attempt);

        const result = ledger.commit<CountPayload>({
          id: `counting:${participantId}:${attempt}`,
          idempotencyKey: `counting:${participantId}:${attempt}`,
          roomId,
          actorId: participantId,
          subject: thread,
          action: CoreAction.threadReplyCommit,
          payload: { kind: "count", value: lastCount + 1 },
          basedOn: [{ subject: thread, version: observedVersion }],
        });

        if (result.status === "committed") {
          return;
        }
        if (result.status === "needs_rebase") {
          staleIntentsRebased += 1;
          continue;
        }

        throw new Error(`${participantId} was rejected: ${result.code}: ${result.message}`);
      }

      throw new Error(`${participantId} exceeded its retry budget.`);
    };
  });

  try {
    await Promise.all(participantLoops.map((run) => run()));
  } catch (error) {
    return failed("counting", error, {
      participants,
      centralScheduler: false,
      staleIntentsRebased,
    });
  }

  const countEvents = ledger.snapshot(thread).events.filter(isCountEvent);
  const counts = countEvents.map((event) => event.payload.value);
  const uniqueCounts = new Set(counts);
  const expected = Array.from({ length: participants }, (_, index) => index + 1);
  const duplicateCount = counts.length - uniqueCounts.size;
  const everyParticipantCounted = new Set(countEvents.map((event) => event.actorId)).size === participants;
  const passed =
    sameNumbers(counts, expected) && duplicateCount === 0 && everyParticipantCounted && staleIntentsRebased > 0;

  return Object.freeze({
    name: "counting",
    passed,
    metrics: Object.freeze({
      participants,
      committedCounts: counts.join(","),
      duplicates: duplicateCount,
      staleIntentsRebased,
      everyParticipantCounted,
      centralScheduler: false,
    }),
    ...(passed ? {} : { failure: `Expected ${expected.join(",")}, received ${counts.join(",")}.` }),
  });
}

export function runUnrelatedActivityEvaluation(): EvaluationReport {
  const ledger = new InMemoryRoomLedger(roomId);
  const task: SubjectRef = { kind: "task", id: "isolation" };
  const unrelatedThread: SubjectRef = { kind: "thread", id: "unrelated" };

  requireCommitted(
    ledger.commit({
      id: "isolation:create",
      idempotencyKey: "isolation:create",
      roomId,
      actorId: "human",
      subject: task,
      action: CoreAction.taskCreate,
      payload: { title: "Keep conflicts local" },
    }),
  );
  const observedTaskVersion = ledger.currentVersion(task);

  requireCommitted(
    ledger.commit({
      id: "isolation:unrelated",
      idempotencyKey: "isolation:unrelated",
      roomId,
      actorId: "agent:b",
      subject: unrelatedThread,
      action: CoreAction.threadMessageAppend,
      payload: { text: "This must not invalidate the task intent." },
    }),
  );

  const update = ledger.commit({
    id: "isolation:update",
    idempotencyKey: "isolation:update",
    roomId,
    actorId: "agent:a",
    subject: task,
    action: CoreAction.taskUpdate,
    payload: { status: "in_progress" },
    basedOn: [{ subject: task, version: observedTaskVersion }],
  });
  const passed = update.status === "committed";

  return Object.freeze({
    name: "unrelated-activity",
    passed,
    metrics: Object.freeze({
      roomEventsBetweenObserveAndCommit: 1,
      observedTaskVersion,
      finalTaskVersion: ledger.currentVersion(task),
      result: update.status,
    }),
    ...(passed ? {} : { failure: "An unrelated thread event caused a false task conflict." }),
  });
}

export async function runTaskClaimEvaluation(participants = 10): Promise<EvaluationReport> {
  const ledger = new InMemoryRoomLedger(roomId);
  const task: SubjectRef = { kind: "task", id: "claim" };
  requireCommitted(
    ledger.commit({
      id: "claim:create",
      idempotencyKey: "claim:create",
      roomId,
      actorId: "human",
      subject: task,
      action: CoreAction.taskCreate,
      payload: { title: "Claim me" },
    }),
  );
  const observedVersion = ledger.currentVersion(task);

  const results = await Promise.all(
    Array.from({ length: participants }, async (_, index) => {
      await deterministicThinkDelay(index, 1);
      return ledger.commit({
        id: `claim:${index + 1}`,
        idempotencyKey: `claim:${index + 1}`,
        roomId,
        actorId: `agent:${index + 1}`,
        subject: task,
        action: CoreAction.taskClaim,
        payload: { ownerId: `agent:${index + 1}` },
        basedOn: [{ subject: task, version: observedVersion }],
      });
    }),
  );

  const winners = results.filter((result) => result.status === "committed");
  const rejected = results.filter(
    (result) => result.status === "rejected" && result.code === "already_claimed",
  );
  const passed = winners.length === 1 && rejected.length === participants - 1;

  return Object.freeze({
    name: "task-claim",
    passed,
    metrics: Object.freeze({
      participants,
      winners: winners.length,
      rejectedAsAlreadyClaimed: rejected.length,
      winner: winners[0]?.status === "committed" ? winners[0].event.actorId : "none",
    }),
    ...(passed ? {} : { failure: `Expected one winner; observed ${winners.length}.` }),
  });
}

export function runIdempotencyEvaluation(): EvaluationReport {
  const ledger = new InMemoryRoomLedger(roomId);
  const subject: SubjectRef = { kind: "artifact", id: "report" };
  const intent: Intent = {
    id: "idempotency:publish",
    idempotencyKey: "idempotency:publish",
    roomId,
    actorId: "agent:a",
    subject,
    action: CoreAction.artifactPublish,
    payload: { uri: "mesh://artifact/report" },
  };
  const first = ledger.commit(intent);
  const retry = ledger.commit(intent);
  const sameEvent =
    first.status === "committed" && retry.status === "committed" && first.event.id === retry.event.id;
  const replayed = retry.status === "committed" && retry.replayed;
  const passed = sameEvent && replayed && ledger.headSequence === 1;

  return Object.freeze({
    name: "idempotency",
    passed,
    metrics: Object.freeze({ sameEvent, replayed, eventCount: ledger.headSequence }),
    ...(passed ? {} : { failure: "Retry produced a second effect or did not replay the original result." }),
  });
}

export function runCursorRecoveryEvaluation(): EvaluationReport {
  const ledger = new InMemoryRoomLedger(roomId);
  const cursors = new InMemoryCursorStore();
  const thread: SubjectRef = { kind: "thread", id: "recovery" };
  const participantId = "agent:recovering";

  for (let sequence = 1; sequence <= 20; sequence += 1) {
    appendMessage(ledger, thread, `recovery:${sequence}`);
  }
  const beforeRestart = new ParticipantInbox(ledger, cursors, participantId);
  const consumed = beforeRestart.pull();
  beforeRestart.acknowledge(consumed);

  for (let sequence = 21; sequence <= 25; sequence += 1) {
    appendMessage(ledger, thread, `recovery:${sequence}`);
  }
  const afterRestart = new ParticipantInbox(ledger, cursors, participantId);
  const resumed = afterRestart.pull();
  const resumedSequences = resumed.events.map((event) => event.sequence);
  afterRestart.acknowledge(resumed);

  const passed =
    consumed.events.length === 20 &&
    sameNumbers(resumedSequences, [21, 22, 23, 24, 25]) &&
    afterRestart.cursor === 25;

  return Object.freeze({
    name: "cursor-recovery",
    passed,
    metrics: Object.freeze({
      cursorBeforeRestart: consumed.scannedThrough,
      firstSequenceAfterRestart: resumedSequences[0] ?? -1,
      recoveredEvents: resumedSequences.length,
      finalCursor: afterRestart.cursor,
    }),
    ...(passed ? {} : { failure: `Resume returned sequences ${resumedSequences.join(",")}.` }),
  });
}

export function runStaleRebaseEvaluation(): EvaluationReport {
  const ledger = new InMemoryRoomLedger(roomId);
  const task: SubjectRef = { kind: "task", id: "rebase" };
  requireCommitted(
    ledger.commit({
      id: "rebase:create",
      idempotencyKey: "rebase:create",
      roomId,
      actorId: "human",
      subject: task,
      action: CoreAction.taskCreate,
      payload: { title: "Rebase task" },
    }),
  );
  const staleVersion = ledger.currentVersion(task);
  requireCommitted(
    ledger.commit({
      id: "rebase:fresh-update",
      idempotencyKey: "rebase:fresh-update",
      roomId,
      actorId: "agent:b",
      subject: task,
      action: CoreAction.taskUpdate,
      payload: { status: "in_progress" },
      basedOn: [{ subject: task, version: staleVersion }],
    }),
  );

  const stale = ledger.commit({
    id: "rebase:stale-update",
    idempotencyKey: "rebase:stale-update",
    roomId,
    actorId: "agent:a",
    subject: task,
    action: CoreAction.taskUpdate,
    payload: { title: "Old understanding" },
    basedOn: [{ subject: task, version: staleVersion }],
  });
  const conflict = stale.status === "needs_rebase" ? stale.conflicts[0] : undefined;
  const passed =
    stale.status === "needs_rebase" &&
    conflict?.expectedVersion === 1 &&
    conflict.currentVersion === 2 &&
    conflict.changesSinceBasis.length === 1;

  return Object.freeze({
    name: "stale-rebase",
    passed,
    metrics: Object.freeze({
      result: stale.status,
      expectedVersion: conflict?.expectedVersion ?? -1,
      currentVersion: conflict?.currentVersion ?? -1,
      deltaEvents: conflict?.changesSinceBasis.length ?? 0,
      runtimeChoseResolution: false,
    }),
    ...(passed ? {} : { failure: "Stale mutation did not return the relevant subject delta." }),
  });
}

export async function runAllEvaluations(): Promise<readonly EvaluationReport[]> {
  return Object.freeze([
    await runCountingEvaluation(),
    runUnrelatedActivityEvaluation(),
    await runTaskClaimEvaluation(),
    runIdempotencyEvaluation(),
    runCursorRecoveryEvaluation(),
    runStaleRebaseEvaluation(),
  ]);
}

function appendMessage(ledger: InMemoryRoomLedger, subject: SubjectRef, id: string): void {
  requireCommitted(
    ledger.commit({
      id,
      idempotencyKey: id,
      roomId,
      actorId: "human",
      subject,
      action: CoreAction.threadMessageAppend,
      payload: { text: id },
    }),
  );
}

function requireCommitted<T>(result: CommitResult<T>): RoomEvent<T> {
  if (result.status !== "committed") {
    throw new Error(`Setup commit failed with ${result.status}.`);
  }
  return result.event;
}

function isCountEvent(event: RoomEvent): event is RoomEvent<CountPayload> {
  if (event.action !== CoreAction.threadReplyCommit || event.payload === null) {
    return false;
  }
  const payload = event.payload as Partial<CountPayload>;
  return payload.kind === "count" && typeof payload.value === "number";
}

function sameRef(left: SubjectRef, right: SubjectRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function deterministicThinkDelay(participantIndex: number, attempt: number): Promise<void> {
  const milliseconds = ((participantIndex * 7 + attempt * 3) % 5) + 1;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function failed(
  name: string,
  error: unknown,
  metrics: Readonly<Record<string, string | number | boolean>>,
): EvaluationReport {
  return Object.freeze({
    name,
    passed: false,
    metrics: Object.freeze(metrics),
    failure: error instanceof Error ? error.message : String(error),
  });
}
