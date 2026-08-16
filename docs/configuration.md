# Workspace configuration model

Status: **approved for Phase 3A on 2026-08-16**

This document defines the product boundary for local configuration writes. It
does not expand config version 1 or open the adapter registry to external
providers.

## Current storage

`.mesh/config.json` remains the only persisted configuration document in the
first Phase 3A write increment. It is machine-local and must not be committed.
The portable/local classification below governs future explicit import or export;
it does not imply automatic synchronization or a second config file in version 1.

One complete config document is the unit of validation and replacement. Partial
JSON mutation is not a public API because it can bypass cross-field validation
or leave duplicate Agent identities and handles.

## Ownership by setting

| Setting | Classification | Rule |
| --- | --- | --- |
| Room ID | Portable intent | May be included in a future explicit export |
| Agent ID, name, and handle | Portable intent | Define logical participant identity |
| Adapter kind | Portable intent | Version 1 remains limited to the two built-ins |
| System prompt | Portable intent | Export only through an explicit user action; it may contain project-sensitive context |
| `respondToTeam` | Portable intent | Describes collaboration behavior |
| Future provider/model selection | Portable intent | Requires a separately approved adapter contract before entering the schema |
| Adapter command or executable path | Machine-local | Must be re-probed on each machine |
| Permission policy | Machine-local trust | A future import defaults to `deny`; elevated trust never transfers silently |
| Authentication, proxy, and environment | Machine-local | Mesh does not persist credentials in the config document |
| SQLite path and resumable session IDs | Machine-local runtime state | Remain below `.mesh/` and outside configuration exports |

“Portable” means eligible for a deliberate future export. The current ignored
`.mesh/config.json` is still local, and config version 1 continues to store its
existing portable and local fields together.

## Read and write protocol

`previewWorkspaceConfig` stays side-effect-free. A file-backed preview includes
an opaque `revision`; a synthesized default or caller-provided preview uses a
null revision because no file backs that value.

`saveWorkspaceConfig` accepts a complete validated config plus the revision the
caller observed. It:

1. validates and canonicalizes the complete version-1 document before creating
   local state;
2. serializes cooperating Mesh writers with a config-specific lock;
3. rejects a stale revision instead of overwriting newer content;
4. writes a same-directory temporary file, flushes it, and atomically renames it
   over `config.json`;
5. returns the new revision and whether bytes changed.

Revisions are opaque API values even though the current implementation uses a
SHA-256 digest of the exact file bytes. Callers must compare or return them, not
parse them.

An open `MeshWorkspace` is an immutable composition snapshot. Saving different
configuration does not mutate its live adapters, Room, or SQLite composition.
The caller must close and reopen the workspace after a changed save. Desktop
editing preserves this boundary through a replaceable main-process workspace
host: IPC operations are serialized around the transition, the old runtime is
closed, and subscriptions move to the newly composed workspace. A reload failure
attempts to restore the previous persisted config before resuming.

The CLI exposes the same contract as a round-trip workflow. `config preview`
produces an edit document containing the workspace identity, data directory,
revision, and nested config. `config validate` accepts either that document or a
raw config, while `config apply` requires the complete preview document and
rejects a mismatched workspace or stale revision. Users edit only the nested
`config` value.

The Desktop form edits all fields already present in config version 1. It binds
each save to the preview revision, reports conflicts without closing the active
workspace, and offers an explicit disk reload. Provider/model options, Agent
list mutation, and workspace selection remain separate Phase 3A work because
they require schema or onboarding decisions beyond this persistence contract.

## Schema evolution

Version 1 now has executable canonical round-trip coverage for every current
field. Provider/model fields, separate portable/local documents, or any other
schema change require an explicit next-version migration and round-trip fixtures
before the writer accepts them. Unknown future adapters remain invalid.
