import { AcpProcessAdapter } from "@ai-mesh/adapter-acp";
import { createCodexAdapter } from "@ai-mesh/adapter-native";
import type { WorkspaceAdapterKind, WorkspaceAgentConfig } from "@ai-mesh/application";
import type { AgentAdapter } from "@ai-mesh/agent";

/** One code-level implementation of a version-1 workspace adapter kind. */
export interface WorkspaceAdapterProvider {
  readonly kind: WorkspaceAdapterKind;
  create(config: WorkspaceAgentConfig): AgentAdapter;
}

/**
 * Immutable adapter-provider composition used while opening a local workspace.
 *
 * This is a code-level seam, not a dynamic plugin registry. Configuration
 * version 1 still admits only the two verified adapter kinds.
 */
export class WorkspaceAdapterRegistry {
  readonly #providers: ReadonlyMap<WorkspaceAdapterKind, WorkspaceAdapterProvider>;

  constructor(providers: readonly WorkspaceAdapterProvider[]) {
    const byKind = new Map<WorkspaceAdapterKind, WorkspaceAdapterProvider>();
    for (const provider of providers) {
      if (byKind.has(provider.kind)) {
        throw new Error(`Duplicate workspace adapter provider: ${provider.kind}.`);
      }
      byKind.set(provider.kind, provider);
    }
    this.#providers = byKind;
  }

  kinds(): readonly WorkspaceAdapterKind[] {
    return Object.freeze([...this.#providers.keys()]);
  }

  create(config: WorkspaceAgentConfig): AgentAdapter {
    const provider = this.#providers.get(config.adapter);
    if (provider === undefined) {
      throw new Error(`No workspace adapter provider is registered for ${config.adapter}.`);
    }
    return provider.create(config);
  }
}

const builtinWorkspaceAdapterProviders: readonly WorkspaceAdapterProvider[] = Object.freeze([
  Object.freeze({
    kind: "opencode-acp" as const,
    create(config: WorkspaceAgentConfig): AgentAdapter {
      return new AcpProcessAdapter({
        kind: "opencode",
        command: config.command ?? "opencode",
        args: ["acp", "--pure"],
      });
    },
  }),
  Object.freeze({
    kind: "codex-native" as const,
    create(config: WorkspaceAgentConfig): AgentAdapter {
      return createCodexAdapter(config.command ?? "codex");
    },
  }),
]);

export function createBuiltinWorkspaceAdapterRegistry(): WorkspaceAdapterRegistry {
  return new WorkspaceAdapterRegistry(builtinWorkspaceAdapterProviders);
}
