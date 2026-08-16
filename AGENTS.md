# Mesh repository guide for agents

Before changing this repository, read these documents in order:

1. [`docs/project-status.md`](docs/project-status.md) — current implementation baseline,
   verified behavior, limitations, and the next recommended work;
2. [`docs/roadmap.md`](docs/roadmap.md) — milestone status, entry criteria, and phase gates;
3. [`docs/architecture.md`](docs/architecture.md) — stable product and protocol invariants.

Do not infer the current milestone from chat history. Treat the implementation
baseline recorded in `docs/project-status.md` as the handoff point, then verify it
against Git and the code before acting.

## Working agreements

- Preserve the invariant that one Room has one canonical shared event history;
  `attention` decides who wakes, not who can see a message.
- Keep diagnostic traces outside the canonical Room ledger and Agent prompts.
- Do not add a central next-speaker scheduler. Participants react independently
  to shared state and commit through Room policies.
- Stay TypeScript-first. Add Rust only for a measured requirement that TypeScript
  cannot satisfy cleanly.
- Use the `@ai-mesh` npm scope for public package design.
- Treat CLI/runtime APIs as the headless core and the GUI as one client. A TUI is
  not currently planned.
- New runtime state belongs below `MESH_HOME` (default `~/.mesh`), outside user
  projects. Do not commit a legacy project-local `.mesh/`; it may contain local
  configuration, SQLite history, and resumable Agent session metadata.
- After a milestone changes, update both `docs/project-status.md` and
  `docs/roadmap.md` in the same change.

## Required verification

Run `pnpm verify` for any runtime or package change. Also run
`pnpm smoke:desktop` and desktop visual QA when renderer, IPC, or desktop behavior
changes. A phase is not `verified` merely because its implementation is present.
