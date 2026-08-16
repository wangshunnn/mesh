# `@ai-mesh/adapter-native`

Native process/JSONL implementation of the `@ai-mesh/agent` contract, including
the current Codex provider and resumable thread support.

It depends only on `@ai-mesh/agent`. Parsing and process concerns stay here;
Room semantics, configuration selection, persistence, and UI do not.
