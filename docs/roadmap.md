# Mesh implementation roadmap

Last updated: **2026-08-18**

Latest verified increment: **DSH-aligned desktop sidebar actions in the current
working tree on 2026-08-18**

Current position: **Phase 2A verified; Phase 3A navigation and renderer foundation are verified, and Agent onboarding diagnostics are next**

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
| Phase 3 — Local product MVP | In progress (3A enabling) | working tree after `911c4fe` | GUI navigation and shell refinement verified; Agent diagnostics and provider/model semantics remain |
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

Current phase. The configuration model and portable-versus-machine-local
boundary are approved. Headless, CLI, and desktop editing now share the same
safe-write contract; workspace selection and provider/model semantics remain.

Proposed scope:

- [x] Open or create a workspace from the GUI
- [x] Centralize machine-local workspace registration, config, and SQLite below
  `MESH_HOME` without writing metadata into user projects
- [x] Separate project identity from Room sessions with a DSH-inspired
  `storages/` catalog and `sessions/<project-key>/<session-id>/` layout
- [x] Support multiple isolated sessions per workspace through headless
  list/new/select APIs and matching CLI commands
- [x] Maintain a fail-soft derived session title/preview cache so listing does
  not cold-open every SQLite Room
- [x] Migrate the former project-local `.mesh/` layout without merging ambiguous
  split histories
- [x] Migrate the former centralized `workspaces/<workspace-id>/` layout into one
  session without changing canonical Room history
- [x] View and edit versioned Room and Agent configuration safely in Desktop,
  including revision conflicts and explicit disk reload
- [x] Configure current config-v1 adapter command, system prompt,
  `respondToTeam`, and permission policy
- [ ] Define and configure provider/model options through the adapter contract
- [ ] Explain command-not-found, authentication, proxy, and startup failures in UI
- [x] Repair the root `pnpm mesh ...` shortcut under pnpm 11 and add a smoke test
- [x] Preview effective configuration and centralized storage paths without
  creating `MESH_HOME` through the headless API, CLI, and typed desktop IPC/UI
- [x] Approve the config-v1 ownership model: portable intent, machine-local
  commands/trust, no stored credentials, and explicit reload after save
- [x] Add canonical config-v1 parse/serialize round trips and revision-checked,
  serialized atomic persistence to the headless workspace API
- [x] Expose the same safe edit contract through a CLI
  `config preview` → `validate` → `apply` round trip
- [x] Separate the browser-safe application/client contract from the local
  workspace composition root
- [x] Separate config resolution and built-in adapter providers behind an
  immutable code-level registry without opening external plugin loading
- [x] Enforce the internal workspace dependency graph, TypeScript references,
  cycle freedom, and Desktop browser boundary in `pnpm verify`
- [x] Preserve a headless API for workspace/session list, create, select,
  preview, and safe config-write operations
- [x] Add config-v1 round-trip tests before changing its schema
- [ ] Add explicit migration fixtures before introducing a later config version

Entry gate: **satisfied on 2026-08-16**. The approved model is recorded in
[`configuration.md`](configuration.md).

Exit gate: on a clean machine, a user can create a workspace, configure at least
one available Agent, start it, and complete a Room conversation without manually
editing JSON.

Status: **in progress; session-first workspace ownership, headless/CLI/Desktop
session operations, GUI project selection, and desktop config-v1 writes are
implemented, while provider/model options and onboarding diagnostics remain**.

#### Next increment — GUI workspace and session navigation

Status: **verified in the working tree based on `911c4fe` on 2026-08-17**.

- [x] Define browser-safe workspace/session summaries and client operations
- [x] Add typed IPC for catalog list, new session, and explicit session switch
- [x] Add native project-directory selection without writing into the project
- [x] Build a DSH/Codex-inspired project-grouped session sidebar
- [x] Show derived title, preview, recency, active state, and corrupt/missing state
- [x] Flatten the desktop hierarchy around one primary new-session action,
  lightweight project/session rows, and compact Agent presence
- [x] Add a Codex-style 275→0 px left collapse with a native-title-bar action
  and 320→48 px right collapse, with conversation members in the right panel
- [x] Use folder/disclosure project rows and cap the collapsed session list at
  five rows behind an explicit “展示更多” action
- [x] Reuse the workspace's one blank session instead of creating duplicates
  from repeated New Session intents
- [x] Archive redundant historical blanks on Desktop startup, preserving the
  current or newest blank and every underlying Room database
- [x] Allow nonblank current or historical sessions to leave the catalog through
  recoverable archival, switching the live composition before archiving the current
  session and preserving all local Room data
- [x] Match DSH's session-row affordance with a hover ellipsis on the highlighted
  row and local “重命名” / non-destructive “归档会话” actions
- [x] Add project-row hover actions for durable local rename and recoverable
  registration removal, with explicit confirmation that project and Room data stay
  intact and reopening the same directory restores the registration
- [x] Use session-level conversation/trajectory/config tabs with an understated
  underline active state and compact conversation navigation
- [x] Align the renderer with Codex's system font stack, 14/12/11 px type scale,
  neutral gray palette, and macOS title-bar safe inset
- [x] Keep workspace-switch busy state from visually disabling unrelated controls
- [x] Keep inactive project mouse focus visually distinct from the sole active
  session, and verify the collapsed title-bar toggle is a real pointer hit target
- [x] Preserve serialized host replacement when switching the active session
- [x] Test that session switching never merges or reorders canonical histories,
  and that active blank detection uses live Room state
- [x] Extend Electron smoke and 1440×900 / 1040×680 visual QA for the new shell

This increment does not introduce provider/model schema changes, Agent-list
mutation, session branching, multi-Room/thread navigation, or a central speaker
scheduler. Branching remains out of scope until the framework has an approved,
storage-independent snapshot/import/lineage contract.

#### Follow-up increment — Desktop renderer foundation

Status: **verified at `79f53d9` on 2026-08-17**.

- [x] Integrate Tailwind CSS v4 through a dedicated renderer Vite configuration
- [x] Define a semantic light theme for the Codex-aligned 14/12/11 px hierarchy,
  neutral palette, and established sidebar/title-bar dimensions
- [x] Use Radix tabs, collapsibles, dropdown menus, selects, switches, tooltips,
  portals, keyboard navigation, and focus restoration
- [x] Replace general-purpose inline SVG glyphs with Lucide React icons
- [x] Split renderer orchestration, preview fixtures, workspace navigation, Room
  UI, formatting, reusable controls, and trajectory-specific styling
- [x] Replace visual-class smoke selectors with ARIA state and stable `data-ui`
  hooks while retaining the complete navigation/configuration acceptance flow
- [x] Extend 1440×900 and 1040×680 visual QA across Room, configuration, open
  Select, timeline, raw events, and both collapsed sidebars

This increment changes only the renderer implementation and visual foundation;
the browser-safe client contract, typed IPC, Room semantics, config-v1, storage,
and Agent lifecycle remain unchanged.

#### Next increment — Agent onboarding diagnostics

Status: **planned; keep config-v1 unchanged**.

- [ ] Define typed probe/start issue kinds for missing commands, authentication,
  proxy/network, permissions, and process exits
- [ ] Project actionable Chinese recovery guidance without storing credentials
- [ ] Distinguish unavailable, needs-setup, ready, starting, and failed states
- [ ] Add deterministic clean-machine onboarding tests and Electron smoke
- [ ] Measure and document provider/model discovery for both built-in adapters
- [ ] Approve the adapter capability contract and config migration before adding
  provider/model fields or a model picker

This increment does not add credentials, external adapter loading, Agent-list
mutation, or a new config version without explicit migration fixtures.

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

- [ ] Decide which of the now-enforced internal package boundaries become public
  and assign compatibility guarantees only to that supported subset
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
