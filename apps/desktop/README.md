# `@ai-mesh/desktop`

Electron main/preload plus the Chinese React client. Electron main owns the
host-side `MeshWorkspace`; preload and IPC implement the browser-safe
`MeshClient` contract consumed by the sandboxed renderer.

Renderer/shared code may import only `@ai-mesh/application` and
`@ai-mesh/protocol`, and must not import Node built-ins or workspace providers.
The real app and smoke harness share one IPC registration implementation.

Electron main owns a replaceable `DesktopWorkspaceHost`. Typed IPC operations
are serialized across configuration transitions; a changed save closes the old
runtime and rebuilds it from the revision-checked document before publishing the
new snapshot. The renderer can edit all current config-v1 Room and Agent fields
without importing host-side workspace code.
