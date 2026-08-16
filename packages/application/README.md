# `@ai-mesh/application`

Browser-safe product projections and the transport-neutral `MeshClient`
contract used by product clients.

It depends only on `@ai-mesh/protocol`, must not import Node built-ins, and owns
no I/O or runtime implementation. Electron IPC implements this contract today;
a future HTTP client should implement the same boundary instead of exposing
workspace, adapter, or SQLite objects.
