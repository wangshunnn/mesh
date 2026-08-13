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
