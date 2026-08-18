# Background multi-session execution plan

Status: **proposed and gated; not implemented**

Last updated: **2026-08-18**

Mesh currently keeps one live Desktop workspace/session composition. Catalog
entries are cold projections: selecting a session closes the previous runtime,
opens the selected Room, and does not start an Agent merely because the session
became visible. A Human message is committed first, then the active composition
starts only the Agents selected by its `attention`. This document records the
requirements for eventually allowing more than one session to continue in the
background without weakening Room or project safety.

## Product outcome

A user may leave a running session, work in another session, and later return to
the first while its addressed Agents continue. Background execution must remain
explicit and observable. Navigating to, previewing, or restoring a session must
not itself start work.

This capability is not a central next-speaker scheduler. Each Room keeps one
canonical event history, every Agent reacts independently to attention and its
durable cursor, and Room-owned commit policies still decide whether an intent is
accepted.

## Concurrency boundaries

| Case | Required behavior |
| --- | --- |
| Different sessions, different project roots | Independent Room, cursor, trace, adapter, and process state; shared machine/provider budgets still apply. |
| Different sessions, same project root, read-only Agents | May run concurrently after resource limits exist. |
| Different sessions, same project root, write-capable Agents | Must not run concurrently against one mutable checkout without an approved isolation or single-writer policy. |
| The same session opened by two Mesh processes | Exactly one process may own its Agent runtime; other clients may observe or request a handoff. |
| The same vendor resume ID in two live workers | Forbidden. Runtime ownership must fence the stale worker before resume. |

SQLite WAL, idempotency keys, and compare-and-append protect canonical Room
writes, but they are not a runtime-ownership mechanism. They cannot safely
coordinate two workers driving the same Agent or vendor session.

## Required design

### 1. Per-session runtime ownership

- Add a lease below `MESH_HOME` keyed by workspace and session ID.
- Record owner process identity, a heartbeat/expiry, and a monotonically changing
  fencing token.
- Reject a second Agent runtime for the same session while a live lease exists.
- Recover a dead owner without allowing its late callbacks to publish presence,
  advance cursors, or resume a vendor session.
- Define explicit observe, take-over, and handoff behavior; do not silently steal
  a live runtime.

### 2. Desktop runtime registry

- Replace the single replaceable composition with a bounded registry keyed by
  session ID.
- Keep navigation and cold catalog reads independent from runtime creation.
- Start a session runtime only from an explicit Human message, resume action, or
  future user-approved background control.
- Project `cold`, `starting`, `idle`, `working`, `failed`, and `suspended` state to
  the catalog without writing diagnostics into the Room ledger or Agent prompts.
- Route snapshots by session ID so a late background update cannot overwrite the
  currently visible Room.

### 3. Project mutation isolation

- Preserve `deny` as the default permission policy.
- Before enabling concurrent write-capable sessions for one project, approve
  either isolated worktrees/checkouts or an explicit project-level single-writer
  lease.
- Treat the Git index, working tree, build outputs, local ports, generated files,
  and project-local caches as shared mutable resources.
- Do not model worktree creation as Session branching; Room snapshot/import and
  lineage remain a separate protocol decision.

### 4. Resource and lifecycle policy

- Define a small configurable cap for active background sessions and Agent
  processes.
- Apply per-provider concurrency/rate limits and machine CPU/memory safeguards.
- Specify idle suspension, wake, app-quit, OS sleep, crash recovery, and pending
  permission-request behavior.
- Bound Agent start, cancel, and stop operations with adapter-specific escalation
  to forced process termination when graceful cleanup does not finish.
- Preserve resumable Agent metadata only after ownership and shutdown state are
  durably known.

## Delivery sequence

1. Measure current start, first-ready, cancel, stop, switch, and resource costs in
   the diagnostic plane.
2. Add and verify the single-session runtime lease while Desktop still runs only
   one composition. This first turns the current implicit assumption into an
   enforceable cross-process invariant.
3. Introduce the bounded Desktop runtime registry and session-scoped snapshot
   routing for read-only Agents.
4. Add explicit background controls, status, failure recovery, and idle eviction.
5. Approve project mutation isolation before allowing concurrent write-capable
   sessions that share a project root.
6. Add deterministic multi-process, crash-recovery, stale-owner, provider-budget,
   and rapid-navigation acceptance tests.

## Entry and exit gates

Implementation must not start until all of the following are approved:

- runtime lease and fencing semantics;
- adapter start/cancel/stop timeouts;
- project-root mutation isolation;
- background resource limits and user controls;
- session-scoped renderer event routing.

The increment is complete only when two different sessions can make independent
progress, a duplicate opener cannot drive the same Agent session, late events
cannot contaminate the visible Room, and concurrent write-capable work cannot
silently modify one checkout from two sessions.
