# Mesh project status

Last updated: **2026-08-16**

Implementation branch: **`main`**

Starting Git baseline for the current increment: **`b782266`** (`feat(desktop): add read-only workspace config view`)

This file is the primary handoff document. Read it before choosing or
implementing the next milestone.

## Executive state

Mesh is a TypeScript-first, local-first, vendor-neutral collaboration Room for
humans and Agents. The architecture MVP is implemented through Phase 2A: two
real Agent adapters can independently observe one shared Room, work concurrently,
and safely reconcile a candidate response when the Room changes during
generation.

The repository is currently a **verified technical MVP**, not yet a distributable
product MVP. The kernel, local persistence, real-adapter vertical slice, Chinese
Electron GUI, developer trace, and bounded candidate reconciliation exist. Clean
machine onboarding, GUI configuration, packaged releases, a stable public SDK,
and remote multi-machine Rooms do not yet exist.

Phase 3A enabling work has started without changing configuration version 1: the
root `pnpm mesh ...` entry point is repaired and covered by a smoke check, and a
headless effective-config preview can inspect defaults or an existing config
without creating `.mesh/` state. The same effective snapshot now crosses typed
Electron IPC into a read-only desktop configuration view showing its source,
workspace paths, and resolved Room/Agent values. The Phase 3A product
configuration entry gate remains open; no write model has been selected.

The monorepo boundary is now hardened without changing product semantics. A new
browser-safe `@ai-mesh/application` package owns client projections and the
transport-neutral `MeshClient` contract; Desktop renderer/shared code no longer
imports the host-side workspace. Workspace configuration, adapter providers, and
composition are separate modules, with an immutable code-level provider registry
for the two config-v1 adapter kinds. Collaboration projection, reconciliation,
trace, identifiers, and public runtime types are split into focused internal
modules. An executable dependency allowlist and package READMEs document and
enforce the intended seams. This is not external plugin support and does not
resolve the Phase 3A configuration-write gate.

| Area | Current state |
| --- | --- |
| Room kernel | Implemented, evaluated, and accepted in Phase 0 |
| Real Agent vertical slice | Implemented and verified in Phase 1 |
| Candidate reconciliation | Implemented and verified in Phase 2A |
| Desktop product | Chinese local-room GUI with trajectory and read-only configuration views; development build only |
| CLI | Built headless workspace entry point with a verified root `pnpm mesh` shortcut |
| Package architecture | Explicit contract/provider/composition seams; dependency and browser boundaries enforced in `pnpm verify` |
| Persistence | Local SQLite under `.mesh/` |
| Public distribution | Not published; packages are `private`, version `0.0.0` |
| Remote collaboration | Not implemented |
| Current phase | Phase 3A local product configuration and onboarding (read-only boundary) |
| Phase 2B cancellation | Gated on trace evidence; not the default next step |

## Implemented behavior

### Shared Room and concurrency

- One canonical append-only Room event log is visible to every participant.
- Subject-scoped versions prevent unrelated activity from causing false conflicts.
- Room-owned `append`, `compare-and-append`, and `exclusive` policies define
  consistency; a client cannot weaken them.
- Idempotency keys make repeated identical intents safe.
- Every participant has an independent durable inbox cursor and recovers unseen
  events after restart.
- There is no central next-speaker scheduler. `attention` wakes selected Agents,
  while the complete Room history remains shared.
- Tasks support creation, exclusive claim, and state updates.

### Agents and adapters

- `@ai-mesh/agent` defines the common adapter/session contract.
- OpenCode runs through ACP using `@agentclientprotocol/sdk`.
- Codex runs through its native JSONL CLI and can resume a recorded thread ID.
- A scripted adapter provides deterministic tests and evals.
- The default workspace config registers `@opencode` and `@codex`, both responding
  to team attention.
- Adapter permissions default to `deny`; availability is probed before startup.
- Model choice currently comes from the underlying OpenCode or Codex
  configuration. Mesh has no model picker yet.

### Change-aware candidate reconciliation

Ordinary Room changes do not eagerly cancel an in-flight generation. A relevant
change marks the turn `dirty`; after the candidate completes, the same Agent
reviews only the candidate and the coalesced Room delta and chooses:

- `keep` — commit the unchanged candidate against the latest validated version;
- `patch` — commit one locally revised full candidate;
- `regenerate` — discard it and run a complete latest-state attempt;
- `drop` — acknowledge the trigger without publishing a reply.

Current runtime defaults are:

| Policy | Default | Purpose |
| --- | ---: | --- |
| Full rebase attempts | 3 | Bound complete latest-state retries |
| Reconciliation passes | 2 | Bound lightweight candidate reviews |
| Relevant delta events per review | 32 | Avoid large reconciliation prompts in a hot Room |
| Quiet window | 80 ms | Coalesce short Room-change bursts |

All reply commits still use compare-and-append. A concurrent change during
reconciliation causes another bounded pass; exhausted budgets fall back to full
regeneration. Explicit adapter cancellation is not part of Phase 2A.

### Persistence and observability

- `.mesh/config.json` stores versioned workspace and Agent configuration.
- `.mesh/mesh.db` stores Room events, subject versions, idempotency results,
  exclusive slots, participant cursors, and the diagnostic trace journal.
- Presence and turn receipts are shared Room facts.
- Candidate text, tool events, lifecycle timing, dirty detection, expired drafts,
  and reconciliation decisions live in the separate developer trace.
- Trace data never advances Room subject versions, wakes Agents, becomes a chat
  message, or enters Agent prompts.
- The desktop “运行轨迹” is a full-width causal timeline: one Room rail preserves
  canonical message sequence, while each Agent has an independent lane whose
  turns may overlap other Agents but remain serial within that lane.
- Its horizontal layout is an idle-compressed wall-clock scale: elapsed time is
  preserved whenever at least one Agent turn is running, including quiet time
  inside that turn, while only long gaps with no running Agent are capped. The
  overview supports click-to-seek and wheel zoom.
- Trigger, reconciliation-delta, reply, and commit connectors are projected only
  from explicit protocol references (`triggerIds`, `changeEventId(s)`,
  `respondingTo`, and `replyEventId`/exact Room sequence). The UI does not infer
  collaboration rounds from text, timing proximity, or conversational semantics.
- Selecting a Room message or Agent turn highlights its connected evidence and
  opens an inspector with candidate content and state-machine events. Turn bars
  subdivide into explicit generation, candidate-validation, reconciliation, and
  committed phases, while tool calls and Room changes remain nested markers. A
  compact DevTools-style overview supports seeking and exposes concurrent work
  at a glance; a searchable newest-first raw-event view remains available.
- Every Room message stays visible even when diagnostic trace data is incomplete.
  Agent-authored messages without a source turn are explicitly marked as trace
  gaps instead of being omitted or assigned to a synthetic semantic round.

### Product entry points

- `@ai-mesh/application` owns browser-safe product projections and the
  transport-neutral client contract; it contains no host implementation.
- `@ai-mesh/workspace` resolves config and composes SQLite, registered adapter
  providers, and collaboration runtime.
- `@ai-mesh/cli` exposes init, status, Agent lifecycle, messages, tasks, timeline,
  a side-effect-free effective-config preview, and a real-Agent demo.
- `@ai-mesh/desktop` implements the application contract through one shared typed
  Electron IPC registration path and a React GUI, including a read-only
  projection of the effective workspace config.
- The Electron renderer is sandboxed with context isolation and no Node
  integration.

## Verification evidence

The `08f15de` baseline passed on macOS on 2026-08-14:

- `pnpm verify`, including a forced TypeScript project-reference build, package
  export checks, all package tests, renderer/preload builds, and all six Phase 0
  evaluations;
- 16/16 collaboration runtime tests, including concurrent counting, keep, patch,
  drop, regeneration, irrelevant changes, and hot-Room overflow;
- `pnpm smoke:desktop`, including Electron startup, IPC, renderer load, one Room,
  and two configured Agents;
- Playwright visual QA at 1440×900 and the minimum 1040×680 viewport;
- causal Room/Agent timeline and raw-event trace views, expanded candidate
  content, and zero browser console errors or warnings;
- `git diff --check` and a clean forced TypeScript check after the implementation
  commits.

The post-baseline increments were reverified on macOS on 2026-08-16 with
`pnpm verify`, including the root CLI smoke check and desktop causal-projection
regressions, and with `pnpm smoke:desktop`. Desktop visual QA at 1440×900 and
1040×680 confirmed that Room nodes, concurrent Agent lanes, explicit connectors,
the detail inspector, and raw-event search remain usable without document or
panel overflow. The historical Room message “我报 42 ✨” resolves to its original
Codex turn and is not reported as a trace gap. A 107-minute local history with
25 Room messages and 20 Agent turns was also checked on the idle-compressed
wall-clock scale: global idle gaps collapse, Agent elapsed-time ratios remain
intact, and Room labels stay vertically aligned with their timestamp anchors.
The Phase 3A read-only desktop configuration projection passed the full
`pnpm verify` suite and Electron smoke coverage. The smoke opens the typed IPC
projection, navigates to the configuration view, and checks 1440×900 and the
minimum 1040×680 viewport for horizontal overflow and usable Agent-card widths;
browser inspection at 1280×720 reported no console warnings or errors.

The current package-boundary hardening increment passed `pnpm verify` on macOS
on 2026-08-16. The gate checked all 13 workspaces for allowed dependencies,
cycles, declared imports, TypeScript references, and browser/Node separation;
then passed the forced build, package exports, all package tests, 16/16
collaboration tests, and all six kernel evals. `pnpm smoke:desktop` exercised the
same complete IPC registration used by the real app. Captured configuration-view
QA at 1440×900 and 1040×680 showed no clipping, horizontal overflow, unusable
cards, or renderer warning/error diagnostics.

## Known limitations

These are current boundaries, not regressions:

1. **One local product Room.** A workspace config names one Room, and the product
   UI/runtime surface one default `thread:general`. Multi-Room and multi-thread
   navigation are not implemented.
2. **Machine-local state.** SQLite, workspace config, and resumable session
   metadata live under ignored `.mesh/`; they do not sync through Git.
3. **Manual configuration.** The GUI can inspect effective Agent commands,
   permission policies, prompts, and response-to-team behavior, but changing
   them still requires editing `.mesh/config.json`; provider/model settings and
   safe GUI persistence are not defined yet.
4. **Two production adapter kinds.** Workspace validation and its immutable
   code-level provider registry currently accept only `opencode-acp` and
   `codex-native`; there is no dynamic or external plugin loading contract.
5. **Development distribution only.** There is no signed installer, release
   channel, auto-update flow, or published `@ai-mesh/*` package.
6. **No hard invalidation.** Stop/supersede actions do not yet cancel a currently
   running adapter turn. Ordinary Room changes intentionally never do.
7. **Local trust boundary only.** There is no authentication, authorization,
   encryption, tenant isolation, or remote Room server. `attention` is routing,
   not privacy.
8. **Basic task projection.** Task create/claim/status exists, but automatic
    planning, dependency graphs, scheduling, and artifact review workflows do not.
9. **No trace lifecycle policy.** Filtering, export, retention, pruning, and
    performance telemetry are not implemented.

## Resume on another computer

### 1. Transfer the code safely

Verify that the configured Git remote is reachable and push the intended commits
from the current machine first. On the new machine, clone the repository and
confirm that the baseline or a later documented commit is present:

```bash
git log --oneline -5
git status --short
```

Do not commit `.mesh/`. If the exact Room history is required, transfer that
directory separately through a trusted channel after closing Mesh. It may contain
machine-specific commands, local paths, conversation history, and resumable
vendor session identifiers. A fresh `.mesh/` is safer when only development
context—not runtime conversation state—must move.

### 2. Restore the toolchain

Requirements at this baseline:

- Node.js 22 or newer;
- Corepack and pnpm 11.21.0 from the root `packageManager` field;
- `opencode` and/or `codex` installed and authenticated for real-Agent runs.

```bash
corepack pnpm install
pnpm verify
pnpm mesh init
pnpm mesh agents
```

`pnpm verify` is deterministic and does not require real Agent credentials.
`pnpm smoke:desktop` starts a real Electron process and should be run separately.

### 3. Start the product

From the repository root:

```bash
pnpm desktop
```

Electron uses the current process directory as its workspace root. Set
`MESH_WORKSPACE_ROOT=/absolute/project/path` only when launching the desktop app
from another directory or intentionally opening a different workspace.

For a CLI acceptance flow:

```bash
pnpm mesh message --start-agents --to team "报数！"
pnpm mesh timeline --limit 30
```

Real model output is nondeterministic; the automated collaboration tests are the
canonical check for convergence and reconciliation semantics.

### 4. Give a new Agent context

Ask the Agent to read `AGENTS.md`, then this file, `roadmap.md`, and
`architecture.md` before proposing changes. It should report:

- the checked-out Git baseline;
- whether `.mesh/config.json` already exists;
- which configured Agent commands are available;
- whether `pnpm verify` passes;
- which roadmap phase it intends to enter and why its entry criteria are met.

## Code map

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Shared event, intent, payload, task, and trace types |
| `packages/application` | Browser-safe product projections and client contract |
| `packages/room` | Ledger, subject versions, idempotency, and action policies |
| `packages/runtime` | Participant inboxes, durable cursors, and wake hints |
| `packages/agent` | Vendor-neutral adapter and session interfaces |
| `packages/adapter-acp` | OpenCode ACP process adapter |
| `packages/adapter-native` | Codex native JSONL process adapter |
| `packages/collaboration` | Product runtime, projections, Agent workers, prompts, reconciliation |
| `packages/store-sqlite` | Durable Room, cursor, idempotency, exclusive-slot, and trace storage |
| `packages/workspace` | Composition root and versioned local workspace config |
| `packages/evals` | Executable causal/concurrency acceptance scenarios |
| `apps/cli` | Headless CLI over `@ai-mesh/workspace` |
| `apps/desktop` | Electron main/preload, typed IPC, and Chinese React renderer |
| `docs/package-boundaries.md` | Enforced dependency map and extension seams |

## Decisions that should remain stable

- The product is Agent-first but not GUI-dependent: collaboration semantics live
  below the GUI.
- CLI is a headless architectural entry point, not necessarily an end-user
  installation requirement. Electron carries its own Node runtime when packaged.
- TUI work is not planned unless a concrete product need appears.
- TypeScript is preferred over Rust unless profiling or platform constraints show
  a real need.
- Everyone in a Room—human or Agent—shares the same canonical information.
- Wake-up, visibility, and authority are separate concepts.
- No fixed reply order and no central speaker scheduler are allowed in the core.
- Normal Room changes use optimistic completion plus bounded reconciliation, not
  eager cancellation.
- The developer trace must remain outside shared Agent context.
- Community-facing package design uses the `@ai-mesh` npm scope.
- The initial GUI language is Chinese and its visual style should remain simple
  and restrained.

## Open product decisions

Do not silently decide these while implementing an unrelated task:

- what evidence threshold should enable Phase 2B hard cancellation;
- whether multiple threads belong inside one Room before multi-Room support;
- the stable public split between Room SDK, collaboration runtime, adapters, and
  CLI packages;
- how provider, model, command, permissions, and system prompts should appear in
  product configuration;
- installer platforms, signing, release automation, and update policy;
- the trust, identity, authorization, and synchronization model for remote Rooms.

The proposed sequencing and phase gates are maintained in
[`roadmap.md`](roadmap.md).
