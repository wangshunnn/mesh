# `@ai-mesh/room`

Room ledger interfaces and the shared policy engine for append,
compare-and-append, exclusive commits, subject versions, and idempotency.

It depends only on `@ai-mesh/protocol`. The package owns consistency semantics,
not participant scheduling, Agent execution, concrete storage, or product UI.
Storage implementations provide the backend interface without redefining Room
policies.
