import assert from "node:assert/strict";
import test from "node:test";

import {
  runAllEvaluations,
  runCountingEvaluation,
  runCursorRecoveryEvaluation,
  runIdempotencyEvaluation,
  runStaleRebaseEvaluation,
  runTaskClaimEvaluation,
  runUnrelatedActivityEvaluation,
} from "./scenarios.js";

test("unordered counting advances once per participant without a scheduler", async () => {
  const report = await runCountingEvaluation({ participants: 10 });
  assert.equal(report.passed, true, report.failure);
  assert.equal(report.metrics.duplicates, 0);
  assert.equal(report.metrics.centralScheduler, false);
  assert.equal(report.metrics.everyParticipantCounted, true);
  assert.ok(Number(report.metrics.staleIntentsRebased) > 0);
});

test("unrelated room activity does not invalidate a local mutation", () => {
  assert.equal(runUnrelatedActivityEvaluation().passed, true);
});

test("a concurrent task claim has exactly one winner", async () => {
  const report = await runTaskClaimEvaluation(10);
  assert.equal(report.passed, true, report.failure);
  assert.equal(report.metrics.winners, 1);
});

test("a duplicate delivery has one effect", () => {
  assert.equal(runIdempotencyEvaluation().passed, true);
});

test("an inbox resumes from event 21 after acknowledging event 20", () => {
  const report = runCursorRecoveryEvaluation();
  assert.equal(report.passed, true, report.failure);
  assert.equal(report.metrics.firstSequenceAfterRestart, 21);
});

test("a stale mutation receives a rebase delta without automatic resolution", () => {
  const report = runStaleRebaseEvaluation();
  assert.equal(report.passed, true, report.failure);
  assert.equal(report.metrics.runtimeChoseResolution, false);
});

test("the complete Phase 0 evaluation suite passes", async () => {
  const reports = await runAllEvaluations();
  assert.equal(reports.length, 6);
  assert.deepEqual(
    reports.filter((report) => !report.passed),
    [],
  );
});
