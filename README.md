# Mesh

Mesh is a local-first, vendor-neutral causal collaboration room for humans and agents.

The current vertical slice includes:

- an append-only room event ledger;
- subject-scoped versions and causal intent commits;
- SQLite events, idempotency records, and participant cursors;
- independent agent workers over one canonical shared room history;
- an ACP adapter for OpenCode and a native JSONL adapter for Codex;
- an npm-distributed CLI and an Electron + React desktop client;
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

Initialize and inspect a workspace through the CLI:

```bash
pnpm mesh init
pnpm mesh agents
pnpm mesh message --to codex "Review the current room state"
pnpm mesh timeline
```

Run the desktop client after Electron's platform binary has been installed:

```bash
pnpm desktop
```

Both clients open `.mesh/config.json` and `.mesh/mesh.db` beneath the selected
workspace. The CLI is a headless entry point over the same runtime, not a
separate collaboration model.

See [`docs/roadmap.md`](docs/roadmap.md) for milestones and acceptance criteria.
The current kernel design and persistence contract are documented in
[`docs/architecture.md`](docs/architecture.md).
