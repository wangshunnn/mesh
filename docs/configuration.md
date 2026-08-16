# Workspace configuration model

Status: **approved for Phase 3A on 2026-08-16**

This document defines the product boundary for local configuration writes. It
does not expand config version 1 or open the adapter registry to external
providers.

## Current storage

Mesh no longer writes runtime state into the user's project directory. CLI and
Desktop resolve one machine-level home in this order:

```text
explicit API option > MESH_HOME > ~/.mesh
```

The home separates a lightweight workspace catalog from private session data:

```text
~/.mesh/
  storages/
    workspace.json
    session-projection-cache.json
  sessions/
    <readable-project-key-with-hash>/
      <session-id>/
        header.json
        config.json
        mesh.db
```

`storages/workspace.json` maps a stable workspace UUID to the canonical real
project path, display name, timestamps, and an ordered list of opaque session
IDs. New sessions are prepended without reordering older sessions when they are
opened. The directory grouping key remains recognizable from the canonical path
and ends in a truncated SHA-256 digest, so paths that normalize to the same slug
cannot collide. Two projects with the same basename therefore remain distinct.

The ownership model is `Workspace 1:N Session`, with `Session 1:1 Room` in the
current product. Each session has a strict identity header and owns its config
snapshot and canonical SQLite Room history. Mesh keeps SQLite instead of copying
DSH's compressed JSONL representation because Room commit policies require
transactions, subject-scoped compare-and-append, idempotency, exclusive slots,
and durable participant cursors.

`session-projection-cache.json` is a derived, fail-soft sidebar index containing
only title, preview, timestamps, head sequence, and message count. It lets clients
list sessions without opening every database. The first human message supplies a
session title, and the latest message supplies its preview; a missing or corrupt
cache falls back to safe defaults and is repaired by a later checkpoint. The
Room database remains canonical.

The project directory is only a working-directory reference. Opening it does
not create project-local metadata or require a Git ignore rule.

`config.json` remains the only persisted configuration document in config
version 1. It is machine-local and is not an implicit collaboration artifact.
The portable/local classification below governs future explicit import or export;
it does not imply automatic synchronization or a second config file.

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
| SQLite path and resumable Agent session IDs | Machine-local runtime state | Remain in the selected session directory below `MESH_HOME/sessions/` and outside configuration exports |

“Portable” means eligible for a deliberate future export. The registered
`config.json` is still local, and config version 1 continues to store its
existing portable and local fields together.

## Legacy project-local migration

An unregistered workspace containing the former `<project>/.mesh/config.json`
or `mesh.db` layout is migrated on its first mutating open or save. The short-lived
centralized layout from baseline `512a401`, `MESH_HOME/workspaces/<workspace-id>/`,
is migrated by the same protocol. Mesh first validates the legacy config,
registers the canonical project path, chooses one session ID, and then moves the
complete legacy directory to the selected
`MESH_HOME/sessions/<project-key>/<session-id>/`. A cross-device move stages a
complete copy under the project-key directory, publishes it by atomic rename,
and removes the source only after publication.

A side-effect-free preview reports `source: "legacy"` but does not migrate. If
more than one old or current location contains data, Mesh fails loudly instead
of choosing or merging histories. A `MESH_HOME` that overlaps the legacy
directory is also rejected before registration so migration can never move a
directory into itself. Migration, catalog, projection, and config locks
serialize cooperating processes.

## Read and write protocol

`previewWorkspaceConfig` stays side-effect-free. It resolves a registered or
provisional workspace UUID, selected or provisional session ID, and centralized
target paths without creating `MESH_HOME`. A file-backed or legacy preview
includes an opaque `revision`; a synthesized default or caller-provided preview
uses a null revision because no file backs that value.

`saveWorkspaceConfig` accepts a complete validated config plus the revision the
caller observed. It:

1. validates and canonicalizes the complete version-1 document before creating
   local state;
2. binds the save to the previewed workspace and session IDs and atomically
   registers the canonical project path;
3. completes any unambiguous legacy migration;
4. serializes cooperating Mesh writers with a config-specific lock;
5. rejects a stale revision instead of overwriting newer content;
6. writes a same-directory temporary file, flushes it, and atomically renames it
   over `config.json`;
7. returns the new revision and whether bytes changed.

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
produces an edit document containing the workspace UUID, session ID, canonical
project root, Mesh home, data directory, revision, and nested config.
`config validate` accepts either that document or a raw config, while
`config apply` requires the complete preview document and rejects a mismatched
workspace, session, Mesh home, or stale revision. Users edit only the nested
`config` value. `session list` reads the catalog and derived projections without
opening Room databases, `session new` creates an isolated session, and the global
`--session` option explicitly reopens a known session.

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
