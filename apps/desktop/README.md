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

Nonblank sessions expose the same DSH-style hover menu on active and inactive
rows: local rename and recoverable archive. Archive removes
the row from the normal catalog but does not delete its Room database or session
directory; archiving the active row safely opens a replacement first. The host
also archives redundant historical blanks at startup, keeping the current or
newest one per workspace. Project rows expose rename and registration removal;
removal preserves the project and every session and is reversed by opening the
same directory again. If the current registration is the only one, its Room stays
live outside the empty catalog until a directory is opened. Workspace-switch busy state is scoped to navigation so
unrelated controls do not visually flash disabled during a transition.

## Renderer UI stack

The sandboxed renderer uses React 19, Tailwind CSS v4 through the official
Vite plugin, Radix Primitives for stateful accessible controls, and Lucide React
for general-purpose icons. `app.css` owns the light semantic theme and Electron
base rules; dynamic causal-timeline geometry and SVG state styling live in the
separate `trajectory.css` layer.

Renderer components should use the shared controls below `src/renderer/ui/`.
Use complete static Tailwind class names with `clsx` for variants rather than
constructing utility names at runtime. Import Radix primitives from `radix-ui`
subpaths, keep text inputs and structural scrolling native, and reserve custom
SVG for Mesh-specific protocol concepts instead of duplicating Lucide glyphs.

Electron smoke automation targets roles, ARIA state, and stable `data-ui`
attributes. Visual class names are implementation details and must not become a
test API.
