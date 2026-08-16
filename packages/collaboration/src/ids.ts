import { createHash } from "node:crypto";

import type { EventId } from "@ai-mesh/protocol";

export function stableId(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...values].sort())).digest("hex").slice(0, 24);
}

export function collaborationKey(triggerIds: readonly EventId[]): string {
  return `collaboration:${stableId(triggerIds)}`;
}
