# `@ai-mesh/runtime`

Participant inboxes, durable cursor contracts, and lossy wake hints over one
canonical Room ledger.

It depends on `@ai-mesh/protocol` and `@ai-mesh/room`. Wake hints carry no event
body and are never a source of correctness; replay after the acknowledged cursor
is. Product-specific Agent decisions belong in `@ai-mesh/collaboration`.
