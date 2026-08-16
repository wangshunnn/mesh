# `@ai-mesh/protocol`

Canonical, transport-neutral data contracts for Room intents, events, causal
bases, task and presence payloads, commit results, and diagnostic trace records.

This is the lowest shared layer and has no internal package dependencies. Keep
I/O, storage, policy execution, Agent behavior, and client projections out of
this package. Add protocol types here only when they represent durable shared
facts or a stable cross-package contract.
