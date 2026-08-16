# Mesh implementation roadmap

Last updated: **2026-08-16**

Current implementation baseline: **`08f15de`**

Current position: **Phase 2A verified; Phase 3A read-only enabling work is in progress**

Read [`project-status.md`](project-status.md) for the complete handoff snapshot
and known limitations. This roadmap records sequencing and gates, not only a
feature wishlist.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Proposed | Direction is recorded but scope may change |
| Planned | Scope and phase gate are approved |
| In progress | Implementation has started |
| Implemented | Code exists but the complete phase gate has not passed |
| Verified | Automated and required manual phase gates passed |
| Accepted | The maintainer explicitly accepted the verified milestone |
| Gated | Work must not start until its entry criteria are met |

## Milestone summary

| Milestone | Status | Baseline | Outcome |
| --- | --- | --- | --- |
| Phase 0 — Room Kernel | Accepted | `31ef73c` | Causal shared-state kernel and executable evals |
| Phase 1 — Real collaboration vertical slice | Verified | `31ef73c`, `72c4061` | SQLite, real adapters, CLI, Chinese Electron GUI |
| Phase 2A — Candidate reconciliation | Verified | `08f15de` | Bounded keep/patch/regenerate/drop against live Room state |
| Phase 2B — Explicit hard invalidation | Gated | — | Cancel only provably superseded work |
| Phase 3 — Local product MVP | In progress (3A enabling) | — | Onboarding, configuration, complete local workflows, packaging |
| Phase 4 — Community SDK | Proposed | — | Stable public `@ai-mesh` packages and external adapters |
| Phase 5 — Remote Rooms | Proposed | — | Secure multi-machine collaboration |

Future phases remain proposals until the maintainer approves their scope. Phase
numbers describe dependency order, not a promise to implement every item.

## Phase 0 — Room Kernel

Goal: prove that independent participants can safely act on shared Room facts
without a central speaker scheduler.

### Kernel

- [x] Typed protocol for events, intents, subjects, causal bases, and commit results
- [x] Append-only in-memory ledger
- [x] Subject-scoped optimistic concurrency
- [x] Idempotent intent commits
- [x] Participant inbox cursors and recovery

### Executable acceptance scenarios

- [x] Unordered counting without duplicate counts
- [x] Unrelated Room activity does not cause false conflicts
- [x] Exactly one winner when participants claim a task concurrently
- [x] Duplicate delivery returns the original commit result
- [x] A participant resumes after its acknowledged cursor
- [x] A stale object mutation returns the relevant delta for rebase

Exit gate: all six deterministic eval scenarios pass without introducing a
central scheduler.

Status: **accepted**.

## Phase 1 — Real collaboration vertical slice

Goal: prove the same Room model with durable state, real Agent processes, and
both headless and GUI entry points.

- [x] SQLite persistence for events, idempotency, exclusive slots, and cursors
- [x] Common Agent/session contract with independent participant workers
- [x] OpenCode ACP adapter using the TypeScript ACP SDK
- [x] Codex native JSONL adapter with resumable thread IDs
- [x] Shared workspace service used by CLI and Electron clients
- [x] Room chat, attention, timeline, presence, and atomic task claim
- [x] Durable cursor and session recovery paths
- [x] Deterministic Human → A → B → Human acceptance flow
- [x] Unordered `报数！` convergence against live Room state
- [x] Chinese, restrained desktop GUI
- [x] Desktop renderer visual QA at 1440×900 and minimum 1040×680

Acceptance flow:

```text
Human -> Room -> Agent A -> Room -> Agent B -> Room -> Human
```

Exit gate:

- forced TypeScript project-reference build is clean;
- public workspace-package imports resolve;
- package tests and collaboration evals pass;
- real Electron startup, IPC, and renderer smoke passes;
- desktop QA produces no browser console diagnostics.

Status: **verified**. The architecture vertical slice is complete; distribution
and onboarding are deferred to Phase 3.

## Phase 2 — Live-state response correctness

### Phase 2A — Candidate reconciliation

Goal: preserve useful in-flight work when the Room changes, without letting a
stale candidate enter canonical history.

- [x] Subject-aware Room change classifier
- [x] Per-turn delta buffer without eager cancellation
- [x] Coalesced `keep`, `patch`, `regenerate`, and `drop` protocol
- [x] Bounded reconciliation passes with compare-and-append as the final guard
- [x] Durable developer trace for dirty detection, delta review, and outcome
- [x] Concurrent counting patches one stale number without repeating the full turn
- [x] Multiple soft updates coalesce into one review
- [x] Hot Room overflow bypasses review and falls back to one full retry
- [x] Unrelated task activity does not dirty a thread turn
- [x] Desktop trace separates the canonical serial Room rail from concurrent
  per-Agent turn lanes, draws only explicit trigger/delta/reply/commit links,
  flags incomplete trace coverage, folds only globally idle wall-clock gaps on a
  zoomable axis while preserving Agent turn durations, subdivides turns from
  explicit state-machine phase boundaries, and retains searchable raw events

Exit gate:

- ordinary Room messages never eagerly cancel an Agent turn;
- short bursts coalesce for 80 ms by default;
- a review contains at most 32 relevant delta events by default;
- reconciliation is bounded to two passes by default before full regeneration;
- stale or dropped candidates never become canonical Room messages;
- forced TypeScript, package tests, evals, Electron smoke, and desktop visual QA pass.

Status: **verified** at `08f15de`.

### Phase 2B — Explicit hard invalidation

Goal: cancel expensive work only when a typed user or protocol action makes the
current turn definitively obsolete.

Proposed scope:

- [ ] Define typed stop/supersede semantics and their authority rules
- [ ] Classify only those explicit actions as `hard`
- [ ] Map hard invalidation onto adapter cancellation capabilities
- [ ] Make cancel-versus-complete races deterministic and traceable
- [ ] Persist a clear cancelled receipt without publishing partial output
- [ ] Add evals for cancellation savings, restart churn, and unsupported adapters

Entry gate:

- Phase 2A trace data demonstrates meaningful wasted work that cancellation would
  actually avoid;
- the stop/supersede authority model is explicitly approved;
- each real adapter's cancellation behavior is measured, not assumed.

Exit gate:

- ordinary Room activity still never cancels work;
- explicit cancellation cannot publish a partial or stale candidate;
- unsupported adapters degrade safely;
- trace evidence can explain who cancelled what, why, and at which Room version.

Status: **gated**. Do not implement by default; Phase 3A currently has higher
product value.

## Phase 3 — Local product MVP

Goal: turn the verified architecture MVP into a product that a new user can
configure, understand, and run without editing implementation files.

### Phase 3A — Workspace, Agent, and model configuration

Current phase. Read-only inspection and headless foundations may proceed while
configuration persistence remains behind the entry gate.

Proposed scope:

- [ ] Open or create a workspace from the GUI
- [ ] View and edit versioned Room and Agent configuration safely
- [ ] Configure adapter command, provider/model options, system prompt,
  `respondToTeam`, and permission policy
- [ ] Explain command-not-found, authentication, proxy, and startup failures in UI
- [x] Repair the root `pnpm mesh ...` shortcut under pnpm 11 and add a smoke test
- [x] Preview effective configuration without writing `.mesh/config.json`
  through the headless API, CLI, and typed desktop IPC/UI
- [ ] Preserve a headless API for the same operations
- [ ] Add config migration and round-trip tests before changing config version 1

Entry gate: approve the product configuration model and decide which settings are
portable versus machine-local.

Exit gate: on a clean machine, a user can create a workspace, configure at least
one available Agent, start it, and complete a Room conversation without manually
editing JSON.

Status: **in progress at the read-only boundary; configuration writes remain gated**.

### Phase 3B — Complete local collaboration workflows

Proposed scope:

- [ ] Define Room versus thread navigation before adding either UI
- [ ] Complete task creation, assignment, state, and review interactions
- [ ] Add trace filtering, search, export, retention, and pruning
- [ ] Add explicit empty, loading, recovery, and error states
- [ ] Add deterministic product evals for multi-Agent delegation and shared-state work
- [ ] Measure reconciliation frequency, decisions, latency, and token overhead locally

Entry gate: approve multi-thread/multi-Room semantics and a trace privacy/retention
policy.

Exit gate: the core local workflows are usable without developer-only knowledge,
and their correctness remains executable in evals.

Status: **proposed**.

### Phase 3C — Desktop distribution

Proposed scope:

- [ ] Produce installable desktop artifacts for approved platforms
- [ ] Bundle the application runtime so end users do not install Node.js
- [ ] Decide signing, notarization, release channel, and update policy
- [ ] Add clean-install, upgrade, data-location, and uninstall documentation
- [ ] Verify how external Agent CLIs are discovered and upgraded

Entry gate: approve target platforms and release/security policy.

Exit gate: a clean supported machine can install, launch, preserve workspace data
across upgrades, and diagnose missing external Agent dependencies.

Status: **proposed**.

## Phase 4 — Community SDK and adapter ecosystem

Goal: expose the Room and participant model as stable `@ai-mesh` packages without
requiring the desktop product.

Proposed scope:

- [ ] Decide public package boundaries and compatibility guarantees
- [ ] Publish a minimal Room/collaboration SDK under the `@ai-mesh` scope
- [ ] Publish a headless CLI package only where it improves integration workflows
- [ ] Define an external Agent adapter contract and conformance suite
- [ ] Provide ACP and scripted reference adapters plus end-to-end examples
- [ ] Generate API documentation and migration notes
- [ ] Remove `private: true` only from explicitly supported packages

Entry gate: Phase 3 has exercised the APIs enough to identify a small stable
surface. Internal monorepo boundaries must not be published by accident.

Exit gate: an external TypeScript project can create or join a local Room, add a
conforming participant, recover its cursor, and pass the conformance suite.

Status: **proposed**.

## Phase 5 — Remote and multi-machine Rooms

Goal: preserve the same causal Room semantics across machines and trust
boundaries.

Proposed scope:

- [ ] Specify Room identity, human/Agent identity, authentication, and authorization
- [ ] Define transport-independent commit, subscription, and cursor APIs
- [ ] Add encrypted transport and explicit data-at-rest policy
- [ ] Support reconnect, replay, backpressure, and offline recovery
- [ ] Decide server authority, tenancy, retention, and audit semantics
- [ ] Keep the local SQLite implementation as a valid local mode or cache
- [ ] Add distributed concurrency and fault-injection evals

Entry gate: approve the security and authority model before selecting transport or
hosting technology.

Exit gate: multiple machines converge on one replayable Room history under
disconnects, retries, and concurrent actions without weakening local invariants.

Status: **proposed; intentionally later**.

## Explicitly not on the current roadmap

- A TUI, unless a concrete workflow demonstrates value beyond the CLI and GUI.
- A central orchestrator that assigns the next speaker for ordinary Room dialogue.
- Rust rewrites without measured performance, packaging, or systems requirements.
- Remote sync before identity, authority, privacy, and retention semantics are
  approved.
