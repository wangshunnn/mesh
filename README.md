# Mesh

[English](README.md) | [简体中文](README.zh-CN.md)

**A local-first collaboration room where humans, Codex, and OpenCode work from one shared history.**

> **Technical Preview** — Mesh has a verified architecture MVP and a usable
> local desktop experience. The local product MVP is still in progress: run it
> from source today; packaged releases and complete first-run Agent onboarding
> are not available yet.

![Mesh desktop showing a human, OpenCode, and Codex collaborating in one Room](docs/assets/mesh-room.png)

Mesh gives every participant an independent runtime while keeping collaboration
facts in one canonical, replayable Room. Agents wake from message attention,
observe the same latest history, work concurrently, and commit through Room-owned
consistency policies. There is no central next-speaker scheduler.

## What you can do today

| Surface | Available now |
| --- | --- |
| Shared Room | Chat with a Human, OpenCode, and Codex over one canonical event history |
| Multi-Agent work | Address one Agent or the team; each Agent reacts independently and can run concurrently |
| Safe live-state handling | Reconcile an in-flight candidate with newer Room changes through bounded keep, patch, regenerate, or drop decisions |
| Projects and sessions | Open project directories, create isolated sessions, rename or archive them, and recover local history |
| Members and tasks | Inspect Agent state, start or stop an Agent explicitly, and create, claim, or update tasks |
| Run trajectory | Explore Room messages, overlapping Agent turns, explicit causal links, reconciliation, and raw diagnostic events |
| Configuration | Edit current Room and Agent settings through revision-checked Desktop and CLI workflows |
| Local persistence | Keep configuration, Room history, cursors, resumable Agent metadata, and diagnostics below `MESH_HOME` |

The Desktop UI is currently Chinese. The CLI and runtime packages expose the
same collaboration model for headless use.

## See how the Agents collaborated

The trajectory view separates canonical Room history from local diagnostic
evidence. Room messages stay strictly ordered while Agent lanes show concurrent
generation, validation, reconciliation, and commit phases. Diagnostic trace data
never enters the Room ledger or Agent prompts.

![Mesh trajectory view showing concurrent Agent turns and explicit causal links](docs/assets/mesh-trajectory.png)

_Screenshots use the renderer's deterministic, anonymous preview data._

## Quick start

The current development flow is verified on macOS. You need:

- Node.js 22 or newer;
- Corepack, using the pnpm version pinned by this repository;
- `codex` and/or `opencode` installed and authenticated for real-Agent runs.

Install dependencies and launch the Desktop app:

```bash
corepack pnpm install
pnpm desktop
```

Mesh initially opens the current directory as a project. Use **打开项目** to
choose another directory, review the session configuration, and send a message
to one Agent or the whole team. Opening or switching sessions keeps Agents cold;
after a Human message is committed, Mesh starts only the Agents selected by its
resolved `attention`.

For a headless acceptance flow:

```bash
pnpm build
pnpm mesh init
pnpm mesh agents
pnpm mesh message --start-agents --to team "Review the latest Room state"
pnpm mesh timeline --limit 30
```

Real model output is nondeterministic. Mesh's executable evaluations are the
canonical checks for concurrency and reconciliation behavior.

## Why Mesh is different

- **One shared reality.** Every Human and Agent can replay the same Room history.
  `attention` controls who wakes, not who can see a message.
- **Independent participants.** Each Agent owns its subscription, durable cursor,
  session, and decision loop.
- **Concurrency without a speaker queue.** Room policies and causal versions make
  concurrent commits safe without appointing a central orchestrator.
- **Useful work survives change.** Ordinary Room activity does not eagerly cancel
  generation; a completed candidate is reconciled against relevant deltas before
  it can enter canonical history.
- **Local-first ownership.** Projects are working directories, not storage
  containers. Mesh does not add metadata to them.
- **Observability without context pollution.** Tool calls, candidate text,
  timing, and reconciliation evidence remain in a separate local trace.
- **Vendor-neutral core.** The collaboration protocol is below the built-in
  OpenCode ACP and Codex native adapters.

## How it is built

Package names below are shortened: `name` means `@ai-mesh/name`. Horizontal
arrows show direct internal dependencies; vertical arrows show composition
flow. All packages are currently private workspace packages, not published npm
packages.

```text
+---------------------------------- PRODUCT CLIENTS -----------------------------------+
| cli              --> protocol + workspace                                            |
| desktop          --> application + protocol + workspace                              |
| desktop renderer --> application + protocol only                                     |
+--------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------- COMPOSITION ROOT ----------------------------------+
| workspace --> application + agent + collaboration + protocol + room                  |
|              + adapter-acp + adapter-native + store-sqlite                           |
+--------------------------------------------------------------------------------------+
                     +---------------------+-----------------------+
                     |                                             |
                     v                                             v
+--------- PRODUCT ORCHESTRATION ----------+   +--------- CONCRETE PROVIDERS ----------+
| collaboration --> application + agent    |   | adapter-acp    --> agent              |
|                   + protocol + room      |   | adapter-native --> agent              |
|                   + runtime              |   | store-sqlite   --> protocol           |
|                                          |   |                   + room              |
|                                          |   |                   + runtime           |
+------------------------------------------+   +---------------------------------------+
                     |                                             |
                     +---------------------+-----------------------+
                                           |
                                           v
+---------------------------- CONTRACTS AND CORE POLICIES -----------------------------+
| application --> protocol                                                             |
| room        --> protocol                                                             |
| runtime     --> room + protocol                                                      |
| agent       --> (no internal package dependencies)                                   |
+--------------------------------------------------------------------------------------+
```

`@ai-mesh/evals` sits outside the product runtime and verifies `protocol`,
`room`, and `runtime`. The exact dependency allowlist is enforced by
`pnpm check:boundaries` and documented in
[`docs/package-boundaries.md`](docs/package-boundaries.md).

Clients submit typed intents but cannot choose weaker consistency semantics.
The Room owns append, compare-and-append, and exclusive action policies. Sequence
numbers provide replay order; subject-scoped versions prevent unrelated activity
from causing false conflicts; idempotency keys make retries safe.

## Local data and trust boundary

Mesh keeps runtime state outside user projects:

```text
~/.mesh/                         # override with MESH_HOME
  storages/
    workspace.json               # project and session catalog
    session-projection-cache.json
  sessions/
    <project-key>/<session-id>/
      header.json
      config.json
      mesh.db                     # Room, cursors, resumable metadata, trace
```

Credentials are not stored in workspace configuration. The current product has
a machine-local trust boundary: it does not provide remote synchronization,
authentication, authorization, encryption, or tenant isolation.

## Project status

| Milestone | Status |
| --- | --- |
| Phase 0 — Room kernel | Accepted |
| Phase 1 — Real collaboration vertical slice | Verified |
| Phase 2A — Change-aware candidate reconciliation | Verified |
| Phase 2B — Explicit hard invalidation | Gated on trace evidence and an approved authority model |
| Phase 3 — Local product MVP | In progress; workspace/session UX and config-v1 editing are verified |
| Phase 4 — Public `@ai-mesh` SDK | Proposed |
| Phase 5 — Remote Rooms | Proposed |

The next product increment is typed Agent onboarding diagnostics for missing
commands, authentication, proxy/network, permissions, and process exits. A
provider/model capability contract and configuration migration must be approved
before Mesh adds a model picker.

Current boundaries include:

- one Room per session and one live Desktop session composition;
- no provider/model picker or Agent-list mutation;
- no signed installer, release channel, or auto-update flow;
- no public packages or external adapter plugin contract;
- no background multi-session execution or remote Rooms.

See [`docs/project-status.md`](docs/project-status.md) for the verified handoff
baseline and known limitations, and [`docs/roadmap.md`](docs/roadmap.md) for phase
gates and sequencing.

## Development

Run the complete deterministic repository gate:

```bash
pnpm verify
```

It enforces package boundaries, forces a clean TypeScript project-reference
build, checks public exports, builds the preload and renderer, runs package tests,
and executes all kernel and collaboration evaluations. Run the real Electron
startup, IPC, renderer, and layout smoke separately:

```bash
pnpm smoke:desktop
```

Useful focused commands:

```bash
pnpm check
pnpm test
pnpm eval counting
pnpm smoke:cli
```

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Shared events, intents, task, attention, and trace types |
| `packages/application` | Browser-safe projections and the transport-neutral client contract |
| `packages/room` | Canonical ledger, subject versions, idempotency, and action policies |
| `packages/runtime` | Participant inboxes, durable cursors, and wake hints |
| `packages/agent` | Vendor-neutral adapter and session contracts |
| `packages/adapter-acp` | OpenCode over Agent Client Protocol |
| `packages/adapter-native` | Codex over its native JSONL CLI |
| `packages/collaboration` | Agent workers, prompts, projections, trace, and candidate reconciliation |
| `packages/store-sqlite` | Durable Room, cursor, idempotency, task-slot, and trace persistence |
| `packages/workspace` | Local composition root, session catalog, storage, and configuration |
| `packages/evals` | Executable causal and concurrency acceptance scenarios |
| `apps/cli` | Headless product entry point |
| `apps/desktop` | Electron main/preload and the Chinese React renderer |

## Documentation

- [`docs/project-status.md`](docs/project-status.md) — current implementation,
  verification evidence, limitations, and next work;
- [`docs/roadmap.md`](docs/roadmap.md) — milestones, phase gates, and future scope;
- [`docs/architecture.md`](docs/architecture.md) — stable Room, runtime,
  persistence, adapter, and trace invariants;
- [`docs/configuration.md`](docs/configuration.md) — workspace configuration,
  storage ownership, safe writes, and schema evolution;
- [`docs/package-boundaries.md`](docs/package-boundaries.md) — enforced monorepo
  dependency and browser/host boundaries;
- [`docs/background-sessions.md`](docs/background-sessions.md) — gated design for
  future background multi-session execution.

Start with [`docs/README.md`](docs/README.md) when resuming development or handing
the project to another Agent.
