# `@ai-mesh/store-sqlite`

SQLite providers for durable Room state, idempotency, exclusive slots,
participant cursors, and the separate diagnostic trace journal.

It implements contracts from protocol, Room, and runtime. It owns transactional
persistence and migrations, not Room policy definitions, Agent behavior,
workspace configuration, or client concerns.
