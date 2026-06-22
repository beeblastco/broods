/** Optimistic-update helper for `toolService.upsertForNode` writes from the tool tabs. */
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";

type UpsertArgs = {
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    nodeId: string;
    nodeLabel: string;
    sourceCode?: string;
    language?: "javascript" | "python";
    status?: "enabled" | "disabled";
};

/**
 * Patches the cached `getByNode` row so a tool enable/disable or source edit shows
 * instantly. Bails on the first-ever upsert (no cached row) since the server assigns
 * the document id; that initial write resolves via the round-trip, later ones are instant.
 */
export function applyToolServiceUpsert(localStore: OptimisticLocalStore, args: UpsertArgs): void {
    const key = { projectId: args.projectId, environmentId: args.environmentId, nodeId: args.nodeId };
    const existing = localStore.getQuery(api.toolService.getByNode, key);
    if (!existing) {
        return;
    }

    localStore.setQuery(api.toolService.getByNode, key, {
        ...existing,
        nodeLabel: args.nodeLabel.trim() || existing.nodeLabel,
        sourceCode: args.sourceCode ?? existing.sourceCode,
        language: args.language ?? existing.language,
        status: args.status ?? existing.status,
    });
}
