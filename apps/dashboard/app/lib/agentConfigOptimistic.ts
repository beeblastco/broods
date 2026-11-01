import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { agentCanvasBadge } from "@broods/convex/model/agentConfigCodec";
import type { OptimisticLocalStore } from "convex/browser";

/**
 * Shallow-merges an `agentConfig.update` patch onto the cached `getById` result
 * so node side-panel edits render instantly before the server round-trip. Mirrors
 * the mutation's own semantics of ignoring `undefined` fields. The canvas cards
 * draw from `canvasBadges`, so the edited agent's badge is redrawn from the
 * merged config too.
 */
export function applyAgentConfigUpdate(
  localStore: OptimisticLocalStore,
  args: { configId: Id<"agentConfigs"> } & Record<string, unknown>,
): void {
  const { configId, ...rest } = args;
  const existing = localStore.getQuery(api.agent.config.getById, {
    configId: configId,
  });
  if (!existing) {
    return;
  }

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) patch[key] = value;
  }

  const next = { ...existing, ...patch } as typeof existing;
  if (rest.outputFormat === null) {
    delete (next as Record<string, unknown>).outputFormat;
  }

  localStore.setQuery(api.agent.config.getById, { configId: configId }, next);

  for (const { args: stageArgs, value } of localStore.getAllQueries(
    api.agent.config.canvasBadges,
  )) {
    if (!value?.[configId]) continue;
    localStore.setQuery(api.agent.config.canvasBadges, stageArgs, {
      ...value,
      [configId]: agentCanvasBadge(next),
    });
  }
}
