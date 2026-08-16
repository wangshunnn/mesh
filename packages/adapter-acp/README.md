# `@ai-mesh/adapter-acp`

ACP process implementation of the `@ai-mesh/agent` contract, currently used for
OpenCode. It owns ACP transport, permissions, process lifecycle, streaming, and
session load/new behavior.

It depends on `@ai-mesh/agent` and the ACP SDK. It must not import Room,
collaboration, persistence, workspace configuration, or UI packages.
