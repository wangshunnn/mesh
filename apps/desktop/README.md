# `@ai-mesh/desktop`

Electron main/preload plus the Chinese React client. Electron main owns the
host-side `MeshWorkspace`; preload and IPC implement the browser-safe
`MeshClient` contract consumed by the sandboxed renderer.

Renderer/shared code may import only `@ai-mesh/application` and
`@ai-mesh/protocol`, and must not import Node built-ins or workspace providers.
The real app and smoke harness share one IPC registration implementation.
