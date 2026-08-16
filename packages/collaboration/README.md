# `@ai-mesh/collaboration`

Product behavior for independent Agent workers over one shared Room: attention,
prompts, replies, tasks, projections, trace emission, causal retries, and bounded
candidate reconciliation.

It depends on application/Agent/protocol/Room/runtime contracts, but not concrete
adapters, SQLite, Electron, or CLI. It must not introduce a next-speaker
scheduler, hide canonical messages by attention, or place diagnostic trace data
in Room history or Agent prompts.
