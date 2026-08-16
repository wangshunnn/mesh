# Mesh

Mesh is a local-first, vendor-neutral causal collaboration room for humans and agents.

The current vertical slice includes:

- an append-only room event ledger;
- subject-scoped versions and causal intent commits;
- SQLite events, idempotency records, and participant cursors;
- independent agent workers over one canonical shared room history;
- an ACP adapter for OpenCode and a native JSONL adapter for Codex;
- a headless CLI package and an Electron + React desktop client;
- a browser-safe application contract between product clients and the local
  workspace composition root;
- room chat, attention, presence, tasks, a persistent developer trace, and restart recovery;
- bounded, change-aware candidate reconciliation that coalesces Room deltas without eager cancellation;
- deterministic idempotency;
- executable collaboration evaluations, including unordered counting.

## Development

```bash
corepack pnpm install
pnpm check
pnpm test
pnpm eval counting
```

Run the repeatable non-GUI phase gate with `pnpm verify`; use
`pnpm smoke:desktop` for the real Electron startup/IPC/renderer smoke test.
`pnpm verify` begins by enforcing the acyclic internal dependency allowlist and
the Desktop browser boundary.

Initialize and inspect a workspace through the CLI:

```bash
pnpm build
pnpm mesh config preview
pnpm mesh init
pnpm mesh agents
pnpm mesh message --to codex "Review the current room state"
pnpm mesh timeline
```

Run `pnpm smoke:cli` to verify the root CLI shortcut independently.

Run the desktop client after Electron's platform binary has been installed:

```bash
pnpm desktop
```

Both clients open `.mesh/config.json` and `.mesh/mesh.db` beneath the selected
workspace. The CLI is a headless entry point over the same runtime, not a
separate collaboration model.

For a new-machine or new-Agent handoff, start with
[`docs/project-status.md`](docs/project-status.md). The documentation reading
order is indexed in [`docs/README.md`](docs/README.md), milestones and acceptance
criteria live in [`docs/roadmap.md`](docs/roadmap.md), and stable design invariants
are documented in [`docs/architecture.md`](docs/architecture.md).
The package dependency map and extension seams are recorded in
[`docs/package-boundaries.md`](docs/package-boundaries.md).
