# Mesh project status

Last updated: **2026-08-18**

Implementation branch: **`main`**

Verified committed implementation baseline: **`739fa32`** (`refactor(workspace): adopt session-first local storage`)

Latest verified increment: **Codex-aligned window-level Desktop right sidebar
and attention-driven Agent startup in the current working tree on 2026-08-18**

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
Electron GUI, developer trace, bounded candidate reconciliation, safe local
config-v1 editing, and GUI workspace/session navigation exist. Provider/model
configuration, complete clean-machine Agent onboarding, packaged releases, a
stable public SDK, and remote multi-machine Rooms do not yet exist.

Phase 3A now has an approved configuration model without changing configuration
version 1. The headless API can parse and canonically serialize all current
fields, preview an opaque file revision without creating `MESH_HOME` state, and
persist one complete validated document through a revision-checked, serialized
atomic replacement. Default workspace creation uses the same safe persistence
path. A changed save deliberately requires the caller to close and reopen the
immutable workspace composition. The CLI exposes a workspace-bound
`config preview` → `validate` → `apply` edit round trip with the same revision
protection. Desktop now exposes the current config-v1 Room and Agent fields as a
validated form over typed IPC; successful saves close and rebuild the workspace,
while conflicts preserve the live composition and can explicitly reload the
newest disk config.

Machine-local ownership is now session-first and remains outside user projects.
CLI and Desktop share `MESH_HOME` (default `~/.mesh`):
`storages/workspace.json` maps canonical project paths to stable workspace UUIDs
and ordered session IDs, while each session owns a strict header, config, and
SQLite Room under `sessions/<project-key>/<session-id>/`. A fail-soft projection
cache lists titles and previews without opening every database. Opening a project
does not modify it or require `.gitignore`. Both the former project-local
`.mesh/` and the former centralized `workspaces/<workspace-id>/` layouts migrate
on first mutating open; ambiguous multiple histories are rejected.

Desktop now consumes browser-safe workspace/session catalog projections over
typed IPC. A native directory picker can register or open another project, the
project-grouped sidebar can create and explicitly select isolated sessions, and
the replaceable host serializes every switch through close-and-open recovery.
Cold summaries expose title, preview, recency, message count, active state, and
missing/corrupt state without giving the renderer direct storage access. The
derived projection writer recovers locks left by dead processes while preserving
live-writer exclusion, so one interrupted cache update cannot freeze every later
session title and preview.

The desktop shell now follows a flatter Codex/DSH-inspired hierarchy. Its left
project navigation uses Codex's 275 px preferred width and collapses completely,
leaving its toggle in the macOS title-bar safe area. The right member/task panel
is a third application-shell column at the outer window edge rather than a child
of the active session view, and it collapses completely from 320 px to 0 while
leaving its toggle at one fixed title-bar coordinate on the outer-right window
edge. The provisional Mesh wordmark is omitted.
Project rows use folder icons that swap to disclosure chevrons on hover, default
to five visible sessions with an explicit overflow action, and keep at most one
reusable blank session. Desktop startup archives redundant historical blanks per
workspace while preserving the current or newest blank. Every valid session,
including a reusable blank or the highlighted current one, exposes DSH-style
hover actions for renaming and recoverable archival. A renamed blank keeps its
explicit title instead of being forced back to “新会话”. Explicit titles remain
local catalog metadata outside the Room ledger. Archiving the current session
first switches to another valid session or a fresh blank. Project
rows expose matching rename and remove actions; removal hides only the registration,
preserves the project directory and all session data, and reopening the same path
restores it. Conversation members live in the right panel.
The renderer now uses the Codex system-font stack, 14/12/11 px type hierarchy,
and neutral gray palette. Room identity, shared-history semantics, Agent actions,
and diagnostic boundaries are unchanged by this visual refinement.

The Room shell now keeps only the active session title in its top bar. Repeated
workspace, local/shared, and Agent-count labels are omitted. Per-session
configuration remains beside “对话 / 轨迹” as the third main-view tab; the left
footer is intentionally empty until application-level settings exist. The right
sidebar is one keyboard-navigable “成员 / 任务” tab panel instead of two stacked
sections. It remains at the window edge across conversation, trajectory, and
configuration views; collapsing it removes the panel and its contents without
leaving an icon rail. Its 46 px title-bar spacer and 32 px tab row match the main
session chrome, so both navigation dividers share one 78 px baseline. Opening,
selecting, or reloading a session leaves its Agents cold. A Human message is
committed first and then starts only the Agents selected by its resolved
`attention`; durable cursors recover that message after startup. Each Agent still
has an independent start/stop action in the member list, so the default does not
remove local lifecycle control.

The Desktop renderer now uses Tailwind CSS v4 through its official Vite plugin,
Radix Primitives for tabs, collapsibles, menus, selects, switches, portals,
tooltips, keyboard navigation, and focus restoration, and Lucide React for
general-purpose icons. The former layered global stylesheet is replaced by one
semantic light-theme entry plus an isolated causal-trajectory CSS layer.
Renderer orchestration, preview fixtures, Room UI, workspace navigation,
formatting, and reusable controls are split into focused modules. Smoke tests use
ARIA state and stable `data-ui` hooks instead of treating visual classes as a
test API. No IPC, Room, configuration, persistence, or Agent behavior changed.

The monorepo boundary is now hardened without changing product semantics. A new
browser-safe `@ai-mesh/application` package owns client projections and the
transport-neutral `MeshClient` contract; Desktop renderer/shared code no longer
imports the host-side workspace. Workspace configuration, adapter providers, and
composition are separate modules, with an immutable code-level provider registry
for the two config-v1 adapter kinds. Collaboration projection, reconciliation,
trace, identifiers, and public runtime types are split into focused internal
modules. An executable dependency allowlist and package READMEs document and
enforce the intended seams. This is not external plugin support; the approved
configuration boundary remains closed to the two built-in adapter kinds.

| Area | Current state |
| --- | --- |
| Room kernel | Implemented, evaluated, and accepted in Phase 0 |
| Real Agent vertical slice | Implemented and verified in Phase 1 |
| Candidate reconciliation | Implemented and verified in Phase 2A |
| Desktop product | Restrained Chinese local-room GUI with cold project/session navigation, attention-driven Agent startup, window-level tabbed member/task sidebar, trajectory, and editable per-session configuration |
| CLI | Headless Room workflows, session list/new/select, and revision-safe config preview, validation, and apply commands |
| Package architecture | Explicit contract/provider/composition seams; dependency and browser boundaries enforced in `pnpm verify` |
| Persistence | Machine-local workspace catalog plus isolated per-session config and SQLite under `MESH_HOME` |
| Public distribution | Not published; packages are `private`, version `0.0.0` |
| Remote collaboration | Not implemented |
| Current phase | Phase 3A local product configuration and onboarding (Agent diagnostics and provider/model contract next) |
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
- Adapter permissions default to `deny`; availability probes are asynchronous,
  briefly deduplicated by command across compositions, and never gate Desktop
  session navigation.
- Desktop commits a Human message before starting the Agents selected by its
  resolved `attention`; open/select/config reload keep Agents cold, and member
  rows retain independent stop/start controls.
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

- `MESH_HOME/storages/workspace.json` stores stable workspace UUIDs, canonical
  project paths, display names, timestamps, and newest-created-first session IDs.
- `MESH_HOME/sessions/<project-key>/<session-id>/header.json` strictly binds a
  session to its workspace UUID, canonical working directory, and creation time.
- The same session directory owns versioned `config.json` and `mesh.db`; the
  database stores Room events, subject versions, idempotency results, exclusive
  slots, participant cursors, resumable Agent metadata, and diagnostic traces.
- `MESH_HOME/storages/session-projection-cache.json` is a derived, fail-soft
  title/preview index. It is outside the Room ledger and may be rebuilt.
- One workspace may own multiple isolated sessions; the current product maps one
  session to one Room.
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
  providers, and collaboration runtime. Its headless config API exposes
  a side-effect-free centralized path preview, workspace/session registration,
  cold session listing, explicit new/select operations, both storage migrations,
  canonical config-v1 parse/serialize, opaque revisions, stale-write rejection,
  and atomic whole-document persistence.
- `@ai-mesh/cli` exposes init, status, Agent lifecycle, messages, tasks, timeline,
  session list/new/select, a side-effect-free effective-config preview, config
  validation and safe apply, and a real-Agent demo.
- `@ai-mesh/desktop` implements the application contract through one shared typed
  Electron IPC registration path and a React GUI. Its replaceable workspace host
  serializes requests across config saves, closes the old runtime, rebuilds from
  the saved document, and publishes the new snapshot. The configuration form
  edits every current config-v1 Room/Agent field and surfaces stale-write reload.
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

The Phase 3A headless configuration persistence increment passed `pnpm verify`
on macOS on 2026-08-16. Workspace tests cover every current config-v1 field in a
canonical round trip, default creation through the safe writer, no-op saves,
successful replacements, stale revision conflicts, and temporary/lock cleanup.
The full gate also passed package boundaries, forced TypeScript builds, package
exports, all package tests, 16/16 collaboration tests, and all six kernel evals.
`pnpm smoke:desktop` also passed the typed config preview over IPC and the
configuration layouts at 1440×900 and 1040×680.

The following CLI configuration slice also passed `pnpm verify` on 2026-08-16.
Four CLI tests cover side-effect-free preview and validation, first creation from
an edited preview, persisted updates, stale-revision rejection, and rejection of
an edit document bound to another workspace. The root `pnpm mesh --help` smoke
now exposes `config preview`, `config validate`, and `config apply`.

The Desktop config-v1 editing increment passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-16. Nineteen desktop tests include
three replaceable-host cases for successful save/reload, stale-write safety, and
explicit adoption of a newer external config. The Electron smoke edits an Agent
name through the rendered form, saves it across typed IPC, verifies the rebuilt
workspace and non-null revision, and then checks 1440×900 and 1040×680 layouts
without renderer warnings, errors, or horizontal overflow. Captured screenshots
at both sizes were visually checked for usable controls, cards, paths, and scroll.

The centralized `MESH_HOME` workspace-storage increment passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-16. Twelve workspace tests cover
side-effect-free preview, stable UUID registration, same-name project roots,
centralized config and Room persistence, legacy history migration, split-store
rejection, and overlapping-path protection. Four CLI tests and nineteen Desktop
tests run against isolated machine-level homes. Electron smoke also confirms that
opening and editing a workspace creates no project-local `.mesh/`; visual QA at
1440×900 and 1040×680 found no clipping, horizontal overflow, or unusable path
and configuration controls.

The session-first persistence increment passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-17. Fifteen workspace tests cover strict
session headers, stable collision-resistant project keys, ordered isolated
sessions, cold title/preview projections, corrupt-cache fallback and lazy repair,
explicit session reopen, both legacy storage migrations, and ambiguous-store
rejection. Five CLI tests cover session list/new/select in addition to the config
write protocol; all nineteen Desktop tests, sixteen collaboration tests, and six
kernel evals pass. Electron smoke verified the new catalog/header/session paths,
no project-local or obsolete centralized state, and configuration layouts at
1440×900 and 1040×680. Both captured views were visually checked with no clipping,
horizontal overflow, renderer diagnostics, or unusable controls.

The GUI workspace/session navigation increment passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-17. Sixteen workspace tests include
cold summaries after a project root disappears. Nineteen Desktop package tests
include serialized new/select operations, cross-project switching, stable
session ordering, isolated canonical histories, recovery to the previous live
session, and corrupt-header rejection. Electron smoke edited config, created and
switched two sessions without merging history, opened a second project through
the injected native-picker boundary, returned to the original session, and
reported no renderer warnings or errors. Workspace and configuration screenshots
at 1440×900 and 1040×680 were visually checked with no horizontal overflow,
clipping, or unusable controls.

The subsequent Codex/DSH-style shell refinement also passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-17. Seventeen workspace tests and twenty-one
Desktop package tests covered the original inactive-empty archival boundary and
startup cleanup of redundant historical blanks. Electron smoke clicked the real New
Session control repeatedly to verify blank-session reuse, creates six sessions to
verify the five-row overflow state, opens the DSH-style session menu, archives an
inactive empty session, toggles a project, and checks the zero-width left layout,
real pointer hit target for the fixed title-bar action, single active highlight,
48 px right rail, system font stack, neutral sidebar color, and 14 px body type.
Fresh workspace and configuration captures at 1440×900 and 1040×680 verified the
compact member/task panel and usable chat/config layouts without renderer
diagnostics, clipping, or horizontal overflow. Workspace switching no longer
projects its transient disabled state into unrelated renderer controls.

The DSH-aligned sidebar-action follow-up passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-18. Nineteen workspace tests and
twenty-three Desktop package tests cover registry-v1-to-v2 upgrade, durable
workspace/session titles, active-session archival through
a safe replacement, recoverable workspace removal/restoration, and preservation
of every underlying SQLite database. Electron smoke verifies the active-row
ellipsis, two-item session menu, keyboard focus restoration, two-item workspace
menu, retention confirmation, actual workspace removal, title-bar hit targets,
and 1440×900 / 1040×680 layouts without renderer diagnostics or overflow. Menu,
dialog, expanded, and collapsed screenshots were visually checked at both sizes.

The Tailwind/Radix/Lucide renderer-foundation refactor passed `pnpm verify` on
2026-08-17. The gate retained all seventeen workspace tests, twenty-one Desktop
package tests, sixteen collaboration tests, and all six kernel evals. Electron
smoke verified Radix tabs/selects/switches, keyboard-opened session menus,
Escape dismissal with trigger-focus restoration, project/session workflows,
and the existing 275→0 px and 320→48 px panel contracts. Visual QA covered Room,
configuration, an open Select, causal timeline, raw events, and both collapsed
sidebars at 1440×900 and 1040×680 without renderer diagnostics, clipping, or
horizontal overflow. The production renderer changed from 65.13 kB CSS / 271.53
kB JS to 71.51 kB CSS / 393.11 kB JS before gzip; Radix and Lucide are imported
through tree-shakeable subpaths.

The minimal Room-shell follow-up passed `pnpm verify` and `pnpm smoke:desktop`
on macOS on 2026-08-18. Electron smoke uses deterministic injected adapters to
verify that navigation leaves Agents cold, the first Human team message starts
both configured Agents without launching real vendor CLIs, one Agent can still
be started and stopped from its member row,
that the merged member/task tabs switch correctly, and that configuration opens
as the third main-view tab. The blank-session follow-up recovers dead
derived-cache locks and verifies that blank rows expose their two-item hover
menu. Twenty workspace tests, seventeen collaboration tests, and twenty-nine
Desktop package tests pass. Fresh
1440×900 and 1040×680 captures cover Room, task, configuration, trajectory,
menus, and collapsed sidebars without renderer diagnostics or horizontal
overflow.

The window-level right-sidebar follow-up passed `pnpm verify` and
`pnpm smoke:desktop` on macOS on 2026-08-18. Smoke verifies that the right panel
is rooted in the application shell, spans the complete viewport height, remains
available across Room, trajectory, and configuration views, and collapses to
zero width with no rendered icon rail or hidden focus targets. Follow-up smoke
assertions keep the toggle at the same viewport coordinate across both states
and pin its right edge to the viewport while aligning the right tab-row bottom
and height exactly with the main session navigation. Fresh 1440×900 and
1040×680 captures cover expanded members, tasks, trajectory, configuration, and
the fully collapsed state without renderer diagnostics, clipping, or horizontal
overflow.

## Known limitations

These are current boundaries, not regressions:

1. **One Room per session.** A session config names one Room, and the product
   UI/runtime surface one default `thread:general`. Desktop, CLI, and headless
   APIs can select isolated sessions, but multi-Room and multi-thread navigation
   are not implemented.
2. **Machine-local state.** SQLite, workspace config, and resumable session
   metadata live below `MESH_HOME`; they do not sync through Git. Moving a
   project directory still requires an explicit future rebind flow because the
   registry intentionally does not place an identity marker in the project. The
   Desktop sidebar reports a missing root but cannot rebind it yet.
3. **Incomplete onboarding configuration.** Desktop can choose projects, create
   sessions, edit existing config-v1 Room and Agent fields, and lazily start the
   Agents addressed by Human messages, but it cannot add or remove Agent entries or
   select provider/model options. Authentication and proxy failures still lack
   dedicated product guidance.
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
10. **One live Desktop session.** Catalog sessions are isolated but cold; the
    Desktop host runs only the selected composition. Safe background execution is
    proposed in [`background-sessions.md`](background-sessions.md) and gated on
    runtime ownership, project mutation isolation, and resource policy.

## Next recommended development

The next Phase 3A increment should make Agent onboarding failures diagnosable
without widening config-v1 or storing credentials. Keep provider/model schema
work behind an explicit adapter-contract and migration decision.

Implement the increment in this order:

1. replace free-form probe/start failures with browser-safe typed issue kinds for
   command-not-found, authentication, proxy/network, permission, and process exit;
2. preserve adapter-native detail for diagnostics while projecting concise Chinese
   recovery guidance in Desktop;
3. add an onboarding status surface that distinguishes unavailable, needs setup,
   ready, starting, and failed Agents while preserving attention-driven lazy
   startup and per-member controls;
4. cover clean-machine missing-command and unauthenticated paths in deterministic
   tests and Electron smoke without requiring real credentials;
5. separately inventory how each built-in adapter discovers provider/model
   choices, then approve the common contract and config migration before changing
   the schema or adding a model picker.

Agent-list mutation, multi-Room/thread semantics, remote sync, and Phase 2B
cancellation remain outside this increment.

## Resume on another computer

### 1. Transfer the code safely

Verify that the configured Git remote is reachable and push the intended commits
from the current machine first. On the new machine, clone the repository and
confirm that the baseline or a later documented commit is present:

```bash
git log --oneline -5
git status --short
```

If exact Room history is required, transfer the selected project/session
directory from `MESH_HOME/sessions/` plus its workspace catalog binding through
a trusted channel after closing Mesh. It may contain machine-specific commands,
local paths, conversation history, and resumable vendor session identifiers.
A fresh registration is safer when only development context—not runtime
conversation state—must move. Never commit a legacy project-local `.mesh/`.

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

Electron uses the current process directory as its initial workspace root. Use
the Desktop “打开项目” action to choose another directory. Set
`MESH_WORKSPACE_ROOT=/absolute/project/path` only for scripted startup or when
launching the desktop app from another directory.

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
- the effective `MESH_HOME`, workspace UUID, and whether a legacy project-local
  `.mesh/` needs migration;
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
- how future provider/model selection maps onto each adapter contract;
- installer platforms, signing, release automation, and update policy;
- the trust, identity, authorization, and synchronization model for remote Rooms.

The proposed sequencing and phase gates are maintained in
[`roadmap.md`](roadmap.md).
