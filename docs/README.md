# Mesh documentation

This directory is the durable project memory for maintainers and Agents. It is
intended to be sufficient for resuming work on a new machine without relying on
the original design conversation.

## Reading order

1. [`project-status.md`](project-status.md) — read first. This is the mutable
   snapshot of what exists, what was verified, what is missing, and what to do
   next.
2. [`roadmap.md`](roadmap.md) — milestone history and proposed future phases,
   including explicit entry and exit gates.
3. [`architecture.md`](architecture.md) — stable design invariants and the reasons
   behind the Room, runtime, persistence, adapter, and trace boundaries.
4. The root [`README.md`](../README.md) — short product overview and common
   development commands.

## Source-of-truth rules

- Code and executable tests define actual behavior.
- `project-status.md` records the current handoff baseline and known gaps.
- `roadmap.md` records intended sequencing; future items are not implemented just
  because they appear there.
- `architecture.md` records durable decisions and should not be used as a progress
  tracker.

When a phase is completed, update its status and verification evidence in the
same commit. If the documents disagree with the code, stop, inspect the relevant
tests and Git history, and repair the documents before starting a new phase.
