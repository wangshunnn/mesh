# Mesh collaboration architecture

## Product invariant

One room has one shared, replayable reality and many independent participant minds. The kernel does not select the next speaker or resolve a stale participant's decision on its behalf.

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

`@ai-mesh/workspace` owns configuration, the SQLite connection, adapters, and the
collaboration runtime. Both entry points use that service:

- `@ai-mesh/cli` exposes headless/npm workflows and automation primitives;
- `@ai-mesh/desktop` exposes the same room through typed Electron IPC and React.

The GUI is therefore one client of the collaboration core. Closing it does not
define or erase the room protocol.

## Agent adapters

All adapters implement `@ai-mesh/agent` session semantics. Phase 1 includes:

- OpenCode over ACP, with permission responses and session load/new support;
- Codex over its native JSONL command interface, with thread resume support;
- a scripted adapter used only for deterministic evaluations and tests.

Adapter-private streaming and tool events are normalized into a common event
surface; only durable collaboration facts are written into the shared ledger.
