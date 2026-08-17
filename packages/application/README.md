# `@ai-mesh/application`

Browser-safe product projections and the transport-neutral `MeshClient`
contract used by product clients.

The contract includes cold workspace/session catalog summaries plus explicit
project open, session create, and session select transitions. These projections
contain product state, not workspace providers or filesystem access. The session
archive operation is transport-neutral and returns an updated catalog; the host
implementation owns its safety policy and storage semantics.

It depends only on `@ai-mesh/protocol`, must not import Node built-ins, and owns
no I/O or runtime implementation. Electron IPC implements this contract today;
a future HTTP client should implement the same boundary instead of exposing
workspace, adapter, or SQLite objects.
