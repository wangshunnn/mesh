# `@ai-mesh/workspace`

The local composition root. It resolves and validates effective configuration,
opens SQLite, selects built-in adapter providers, constructs collaboration, and
exposes the headless `MeshWorkspace` service used by CLI and Electron main.

Machine-local state is centralized below `MESH_HOME` (default `~/.mesh`). An
versioned atomic catalog maps canonical project paths to stable workspace UUIDs,
ordered session IDs, explicit display-title overrides, and recoverable archive
sets. Each session owns `header.json`, `config.json`, and `mesh.db` below
`MESH_HOME/sessions/<project-key>/<session-id>/`; a fail-soft derived cache
supports cold session listing. Project directories are not modified. Former
project-local `.mesh/` and centralized `workspaces/<workspace-id>/` layouts are
migrated on the first mutating open after validation; ambiguous split state
fails loudly.

Catalog operations can rename workspaces/sessions and hide sessions or workspace
registrations without deleting project files or SQLite Room histories. Opening an
archived workspace path restores the same registration. Session branching is not
part of this catalog API; a future generic form requires an approved snapshot,
import, and lineage contract.

Configuration inspection is separated from composition. Headless writes require
one complete validated document and the opaque revision returned by the preview;
they use a serialized, atomic replacement and take effect only after the caller
reopens the workspace. See [`docs/configuration.md`](../../docs/configuration.md).

`WorkspaceAdapterRegistry` is an immutable code-level injection seam, not a
dynamic plugin system; config version 1 still accepts only `opencode-acp` and
`codex-native`.
