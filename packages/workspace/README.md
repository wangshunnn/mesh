# `@ai-mesh/workspace`

The local composition root. It resolves and validates effective configuration,
opens SQLite, selects built-in adapter providers, constructs collaboration, and
exposes the headless `MeshWorkspace` service used by CLI and Electron main.

Configuration inspection is separated from composition and remains read-only.
`WorkspaceAdapterRegistry` is an immutable code-level injection seam, not a
dynamic plugin system; config version 1 still accepts only `opencode-acp` and
`codex-native`.
