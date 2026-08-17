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

Desktop and CLI share the same `MESH_HOME` workspace registry. The renderer sees
only typed projections of the stable workspace id and centralized paths; it
never creates or reads project-local Mesh metadata directly.

The Desktop shell exposes a project-grouped session sidebar and a native project
directory picker. Catalog, new-session, and explicit selection requests cross
typed IPC; the host serializes close/open replacement and restores the previous
live session if a target cannot be composed.

Inactive empty sessions can be archived through the same typed boundary. Archive
removes the row from the normal catalog but does not delete its Room database or
session directory. The host also archives redundant historical blanks at startup,
keeping the current or newest one per workspace. The renderer follows DSH's
hover-ellipsis plus “归档会话” menu rather than presenting archive as a destructive
trash action. Workspace-switch busy state is scoped to navigation so unrelated
controls do not visually flash disabled during a transition.
