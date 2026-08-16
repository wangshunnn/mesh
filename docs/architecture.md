# Mesh collaboration architecture

This document records stable design invariants. For current implementation
status, limitations, verification evidence, and the next milestone, read
[`project-status.md`](project-status.md). For sequencing and phase gates, read
[`roadmap.md`](roadmap.md).

## Product invariant

One room has one shared, replayable reality and many independent participant minds. The kernel does not select the next speaker or resolve a stale participant's decision on its behalf.

## Implementation shape

Mesh is a TypeScript monorepo. Protocol, browser-safe application contracts,
Room policies, participant runtime, Agent sessions, collaboration behavior,
persistence, and workspace composition are packages below both product entry
points. The CLI is the headless/core entry point; Electron is a client that
bundles a React renderer and implements the application contract through typed
IPC.

This layering is deliberate:

```text
CLI -------------------------> @ai-mesh/workspace <--- Electron main
                                      |
                                      v
                           collaboration runtime
                             /       |        \
                        adapters   Room     trace journal
                                      |        |
                                      +-- SQLite

React renderer ---> MeshClient ---> preload/typed IPC ---> Electron main
```

The product does not currently need a TUI. Rust remains an option for a future
measured systems constraint, not a default implementation layer.

## Package and capability boundaries

Package seams follow three roles:

1. **definition** packages own transport-neutral contracts;
2. **provider** packages implement one contract without selecting themselves;
3. **composition** packages select providers and own process-local resources.

`@ai-mesh/protocol`, `@ai-mesh/application`, and `@ai-mesh/agent` are definition
layers. The Room/runtime packages provide shared policy and delivery behavior;
adapter and SQLite packages are concrete providers. `@ai-mesh/workspace` is the
local composition root. Product clients never choose Room commit semantics or
receive concrete provider objects.

These boundaries are enforced by `pnpm check:boundaries`, including an explicit
workspace dependency allowlist, cycle detection, manifest/project-reference
agreement, and the browser boundary. Desktop renderer and shared code may import
only `@ai-mesh/application` and `@ai-mesh/protocol`; they cannot import Node
built-ins or reach into the host-side workspace. The complete dependency map and
extension rules are in [`package-boundaries.md`](package-boundaries.md).

## Commit path

```text
observe subject version
  -> decide independently
  -> submit typed intent with causal basis
  -> apply server-owned action policy atomically
  -> committed | needs_rebase + relevant delta | rejected
```

Room sequence numbers provide total ordering for replay. Subject versions provide conflict scope. Unrelated room events therefore do not invalidate an intent.

## Server-owned action policies

Clients submit an action but cannot choose its consistency semantics. The Room maps each action to one of:

- `append`: independent facts may coexist;
- `compare-and-append`: every causal basis must still be current;
- `exclusive`: only one event can occupy an action-defined slot on a subject.

This prevents a client from weakening `task.claim` into an ordinary append operation.

## Inbox and cursor

A participant's logical inbox is a filtered view over the canonical event ledger. Its cursor records the highest sequence safely scanned and acknowledged.

Wake hints are optional and intentionally contain no event body. They improve latency but do not provide delivery guarantees. After a missed hint or restart, pulling from the durable cursor recovers every unacknowledged event.

## Idempotency

Every intent carries an idempotency key. Repeating the identical intent returns the original result and never creates another event. Reusing a key for different intent content is rejected.

## Persistence contract

The in-memory and SQLite backends share one policy engine. The SQLite backend
preserves these atomic boundaries:

1. validate action policy and causal bases;
2. reserve an exclusive slot when required;
3. append the event and advance its subject version;
4. record the idempotency result;
5. commit all four effects in one transaction.

Notifications are emitted only after the transaction commits and may be dropped without affecting correctness.

## Shared information and attention

Every human message, agent reply, task mutation, lifecycle transition, and turn
receipt is appended to the canonical room ledger. All participants can replay
that same history. `attention` is a wake-up decision, not an access-control or
context-filtering mechanism.

Each running agent owns an independent subscription and durable cursor:

```text
canonical room ledger
  -> participant cursor finds unseen facts
  -> attention decides whether to run this agent
  -> prompt contains the complete latest room history
  -> reply is committed against the observed thread version
  -> stale reply rebases against the new room head
```

There is deliberately no fixed speaker order. For a command such as `报数！`,
each addressed agent wakes independently, reads the latest committed room state,
and either commits its next valid action or recomputes after a causal conflict.

## Product entry points

`@ai-mesh/workspace` owns configuration, the SQLite connection, adapter-provider
selection, and the collaboration runtime. Both entry points use that service:

- `@ai-mesh/cli` exposes headless/npm workflows and automation primitives;
- `@ai-mesh/desktop` exposes the same room by implementing the browser-safe
  `MeshClient` contract through preload and typed Electron IPC.

Effective configuration types and client projections live in
`@ai-mesh/application`; side-effect-free resolution and validation live in
`@ai-mesh/workspace`. The CLI and Electron main process invoke the workspace;
the sandboxed renderer receives only the application projection and never reads
`.mesh/config.json` or workspace paths directly. Read-only inspection does not
imply or define future configuration write, credential, or migration policy.

The workspace adapter registry is an immutable code-level injection seam. It
removes provider construction from general workspace lifecycle code and permits
deterministic substitution in tests, but deliberately does not load external
plugins. Configuration version 1 remains a closed union of the two verified
adapter kinds until a public compatibility and security model is approved.

The GUI is therefore one client of the collaboration core. Closing it does not
define or erase the room protocol.

## Agent adapters

All adapters implement `@ai-mesh/agent` session semantics. Phase 1 includes:

- OpenCode over ACP, with permission responses and session load/new support;
- Codex over its native JSONL command interface, with thread resume support;
- a scripted adapter used only for deterministic evaluations and tests.

Adapter-private streaming and tool events are normalized into a common event
surface; only durable collaboration facts are written into the shared ledger.

## Developer trace

The developer-facing trace is a second, local observability plane. It records
room commits alongside runtime-observable lifecycle transitions, tool calls,
candidate replies, causal conflicts, and turn outcomes. In particular, a reply
that loses a compare-and-append race is retained as `agent.draft.expired` with
the version delta that invalidated it.

Trace records are durable, but they are not Room events: they never advance a
subject version, wake another participant, appear as a chat message, or enter an
agent prompt. This preserves the boundary between debugging evidence and the
room's canonical shared facts.

Every turn caused by the same trigger set carries one stable `correlationId`,
including parallel participants and later rebase attempts. Session transitions
also record their previous and next state plus elapsed time. The desktop projects
this evidence as a canonical, sequence-ordered Room rail plus independent Agent
lanes on an idle-compressed wall-clock axis. Time remains linear whenever at
least one Agent turn is active, so concurrent turn widths preserve their actual
elapsed-time ratio; only long intervals with no active Agent are capped. Causal
connectors are drawn only from explicit protocol references; conversational
content and timestamp proximity never decide which turn a message belongs to.
Turn-internal phase bands likewise derive only from explicit candidate,
reconciliation, commit, and terminal trace records; tool and Room-change events
remain nested markers rather than being promoted into inferred phases.
Missing references remain visible as diagnostic gaps, and the newest-first raw
event view is retained for complete inspection.

## Change-aware candidate reconciliation

An in-flight turn watches only the subject version on which its candidate will
commit. The default classifier treats another subject, presence, and task
activity as irrelevant; a newer event on the active thread is a soft change.
Soft changes mark the turn `dirty` and accumulate in a delta buffer without
cancelling generation.

When the candidate completes, the same Agent receives only the old candidate
and the coalesced Room delta. Its internal reconciliation decision is one of:

- `keep`: validate the unchanged candidate against the newer version;
- `patch`: provide one complete, locally revised candidate;
- `regenerate`: discard the candidate and run a full latest-state attempt;
- `drop`: acknowledge the trigger without publishing a reply.

Reconciliation is bounded, and every commit still uses compare-and-append.
Room changes that arrive during review are folded into another bounded pass;
an 80 ms quiet window coalesces short bursts, while more than 32 relevant delta
events or an exhausted pass budget falls back directly to full regeneration.
Both limits are configurable runtime policy rather than protocol semantics.
Immediate adapter cancellation is deliberately outside Phase 2A and can later
be enabled only for explicit hard-invalidating actions.
