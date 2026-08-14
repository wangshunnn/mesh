# Mesh implementation roadmap

## Phase 0 — Room Kernel

Goal: prove that independent participants can safely act on shared room facts without a central speaker scheduler.

### Kernel

- [x] Typed protocol for events, intents, subjects, causal bases, and commit results
- [x] Append-only in-memory ledger
- [x] Subject-scoped optimistic concurrency
- [x] Idempotent intent commits
- [x] Participant inbox cursors and recovery

### Executable acceptance scenarios

- [x] Unordered counting without duplicate counts
- [x] Unrelated room activity does not cause false conflicts
- [x] Exactly one winner when participants claim a task concurrently
- [x] Duplicate delivery returns the original commit result
- [x] A participant resumes after its acknowledged cursor
- [x] A stale object mutation returns the relevant delta for rebase

Phase 1 did not start until these scenarios passed and the milestone was accepted.

Implementation status: **accepted**.

## Phase 1 — Real collaboration vertical slice

- [x] SQLite persistence for events, idempotency, exclusive slots, and cursors
- [x] Common agent/session contract with independent participant workers
- [x] OpenCode ACP adapter using the official TypeScript ACP SDK
- [x] Codex native JSONL adapter with resumable thread IDs
- [x] Shared workspace service used by both CLI and Electron clients
- [x] Basic room chat, attention, timeline, presence, and atomic task claim
- [x] Durable cursor and session recovery paths
- [x] Deterministic Human -> A -> B -> Human acceptance flow
- [x] Unordered `报数！` convergence against live room state
- [x] Desktop renderer visual QA at 1440x900 and minimum 1040x680

Acceptance flow:

```text
Human -> Room -> Agent A -> Room -> Agent B -> Room -> Human
```

Phase gate:

- clean forced TypeScript project-reference build;
- public workspace-package import resolution;
- full automated test suite and collaboration evals;
- no browser console diagnostics during desktop visual QA.

Implementation status: **ready for acceptance**.

## Phase 2 — Change-aware reconciliation

### Phase 2A — Candidate reconciliation

- [x] Subject-aware Room change classifier
- [x] Per-turn delta buffer without eager cancellation
- [x] Coalesced `keep`, `patch`, `regenerate`, and `drop` protocol
- [x] Bounded reconciliation passes with compare-and-append as the final guard
- [x] Developer trace for dirty detection, delta review, and reconciliation outcome
- [x] Concurrent counting patches one stale number without repeating the full turn
- [x] Multiple soft updates coalesce into one review
- [x] Hot Room overflow bypasses review and falls back to one full retry
- [x] Unrelated task activity does not dirty a thread turn

Phase gate:

- no eager cancellation for ordinary Room messages;
- short bursts coalesce for 80 ms by default, with at most 32 relevant delta events per review;
- one full generation plus at most the configured reconciliation budget before a full retry;
- no stale candidate enters the canonical Room history;
- clean TypeScript, test, eval, Electron smoke, and desktop visual checks.

Implementation status: **ready for acceptance**.

### Phase 2B — Explicit hard invalidation

Reserved for explicit stop/supersede actions and adapter cancellation. It will
only proceed after Phase 2A trace data shows that cancellation saves meaningful
work without causing restart churn.
