# Package boundaries

Mesh uses packages to make architectural seams executable, not merely to group
files. The governing pattern is:

```text
contract -> policy/runtime -> product orchestration -> local composition -> client
```

Definitions stay below their implementations. Provider packages implement a
lower-level contract, and the composition root selects concrete providers. A
client consumes the browser-safe application contract instead of importing the
composition root's types.

## Dependency map

| Package | Role | May depend on internal packages |
| --- | --- | --- |
| `@ai-mesh/protocol` | Canonical Room and trace data contracts | — |
| `@ai-mesh/application` | Browser-safe product projections and client contract | `protocol` |
| `@ai-mesh/agent` | Vendor-neutral Agent session contract | — |
| `@ai-mesh/room` | Commit policies and ledger interfaces | `protocol` |
| `@ai-mesh/runtime` | Participant inboxes, cursors, and wake hints | `protocol`, `room` |
| `@ai-mesh/adapter-acp` | ACP Agent provider | `agent` |
| `@ai-mesh/adapter-native` | Native-process Agent provider | `agent` |
| `@ai-mesh/collaboration` | Shared-Room product behavior and projections | `application`, `agent`, `protocol`, `room`, `runtime` |
| `@ai-mesh/store-sqlite` | Durable ledger, cursor, and trace providers | `protocol`, `room`, `runtime` |
| `@ai-mesh/workspace` | Local configuration and composition root | application, adapters, agent, collaboration, protocol, room, SQLite store |
| `@ai-mesh/evals` | Executable kernel acceptance scenarios | `protocol`, `room`, `runtime` |
| `@ai-mesh/cli` | Headless product client | `protocol`, `workspace` |
| `@ai-mesh/desktop` | Electron transport and React client | `application`, `protocol`, `workspace` |

The exact allowlist lives in `scripts/check-package-boundaries.mjs` and runs at
the start of `pnpm verify`. It also rejects workspace cycles, undeclared internal
imports, mismatched TypeScript project references, Node built-ins in browser
code, and host-package imports from Desktop renderer/shared code.

## Extension seams

- Add Room facts and causal semantics in `protocol` and `room`; do not implement
  them in a client.
- Add a vendor transport by implementing `@ai-mesh/agent` in an adapter package.
  Register product-supported providers in the workspace composition root.
- Add a client transport by implementing `MeshClient`; do not expose
  `MeshWorkspace`, SQLite, or adapter objects to browser code.
- Keep diagnostic trace data outside the Room ledger and Agent prompts.

`WorkspaceAdapterRegistry` is intentionally an immutable, code-level injection
seam. It makes built-in providers testable and replaceable during composition,
but it is not external plugin loading. Configuration version 1 remains closed
to `opencode-acp` and `codex-native` until the Phase 3/4 product and compatibility
contracts are approved.
