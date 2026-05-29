/** Optimistic-update helper shared by every side-panel write to `agentConfig.update`. */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

/**
 * Shallow-merges an `agentConfig.update` patch onto the cached `getById` result
 * so node side-panel edits render instantly before the server round-trip. Mirrors
 * the mutation's own semantics of ignoring `undefined` fields.
 */
export function applyAgentConfigUpdate(
    localStore: OptimisticLocalStore,
    args: { configId: Id<"agentConfigs"> } & Record<string, unknown>,
): void {
    const { configId, ...rest } = args;
    const existing = localStore.getQuery(api.agentConfig.getById, { configId: configId });
    if (!existing) {
        return;
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) patch[key] = value;
    }

    localStore.setQuery(
        api.agentConfig.getById,
        { configId: configId },
        { ...existing, ...patch } as typeof existing,
    );
}
