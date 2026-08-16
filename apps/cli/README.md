# `@ai-mesh/cli`

Headless product entry point over `@ai-mesh/workspace`. It exposes workspace
initialization and inspection, Agent lifecycle, messages, tasks, timeline, and a
real-Agent smoke flow without defining a second collaboration model.

Keep Room and Agent behavior in the packages below the CLI. New commands should
delegate to the workspace service and remain suitable for automation.

## Safe configuration edits

The CLI uses the same whole-document, revision-checked persistence contract as
the headless workspace API:

```bash
pnpm mesh config preview --root /path/to/workspace > /tmp/mesh-config-edit.json
# Edit only the nested `config` object.
pnpm mesh config validate /tmp/mesh-config-edit.json --root /path/to/workspace
pnpm mesh config apply /tmp/mesh-config-edit.json --root /path/to/workspace
```

The preview document binds the edit to its stable workspace UUID, canonical
project root, `MESH_HOME`, local data directory, and observed config revision.
Applying it to another workspace/home or after a newer save is rejected. A
successful changed save takes effect when the workspace is reopened; the command
does not mutate a live `MeshWorkspace`.
