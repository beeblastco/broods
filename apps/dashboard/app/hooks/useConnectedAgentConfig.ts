"use client";

/**
 * Resolves the agent config wired to a non-agent canvas node so its side-panel
 * tabs can edit a slice of that agent's nested config (workspace, tools.X,
 * skills.X, workspace.sandbox, etc.).
 */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
    fromNestedAgentConfig,
    toNestedAgentConfig,
    type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { useStore } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { useCallback } from "react";

type ReactFlowState = {
    edges: Array<{ source: string; target: string }>;
    nodeLookup: Map<string, { type?: string; data?: { agentConfigId?: string } }>;
};

/**
 * Walks edges from `nodeId` (BFS) and returns the first reachable agent
 * node's `agentConfigId`. `via` restricts intermediate node types — e.g. a
 * sandbox can only reach an agent through a workspace.
 */
function findReachableAgentConfigId(
    state: ReactFlowState,
    nodeId: string | undefined,
    via?: ReadonlyArray<string>,
): string | undefined {
    if (!nodeId || !state.edges || !state.nodeLookup) return undefined;

    const visited = new Set<string>([nodeId]);
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const edge of state.edges) {
            if (edge.source !== current && edge.target !== current) continue;

            const next = edge.source === current ? edge.target : edge.source;
            if (visited.has(next)) continue;
            visited.add(next);

            const node = state.nodeLookup.get(next);
            if (!node) continue;
            if (node.type === "agent") {
                return node.data?.agentConfigId;
            }
            if (via && via.includes(node.type ?? "")) {
                queue.push(next);
            }
        }
    }

    return undefined;
}

/**
 * Returns the connected agent's config plus an `updateBranch` helper that
 * writes a slice (top-level branch like "workspace" or nested path like
 * ["workspace", "sandbox"]) back through the agentConfig codec.
 *
 * @param nodeId source canvas node id
 * @param via intermediate node types allowed when walking to the agent
 * @returns connected agent config + update helpers, or `null` when nothing wired
 */
export function useConnectedAgentConfig(
    nodeId: string | undefined,
    via?: ReadonlyArray<string>,
) {
    const viaKey = via?.join("|");
    const agentConfigId = useStore(
        useCallback(
            (state: unknown) =>
                findReachableAgentConfigId(state as ReactFlowState, nodeId, via),
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [nodeId, viaKey],
        ),
    ) as Id<"agentConfigs"> | undefined;

    const agentConfig = useQuery(
        api.agentConfig.getById,
        agentConfigId ? { configId: agentConfigId } : "skip",
    );
    const updateConfig = useMutation(api.agentConfig.update);

    /**
     * Writes a JSON value at the given branch path of the nested AgentConfig
     * and persists the projected flat patch to Convex.
     */
    const updateBranch = useCallback(
        async (path: ReadonlyArray<string>, value: unknown) => {
            if (!agentConfigId || !agentConfig) return;
            if (path.length === 0) return;

            const nested = toNestedAgentConfig(agentConfig as FlatAgentConfig);
            let cursor: Record<string, unknown> = nested as Record<string, unknown>;
            for (let i = 0; i < path.length - 1; i += 1) {
                const key = path[i];
                const next = cursor[key];
                if (typeof next !== "object" || next === null || Array.isArray(next)) {
                    cursor[key] = {};
                }
                cursor = cursor[key] as Record<string, unknown>;
            }
            const leaf = path[path.length - 1];
            if (value === undefined) {
                delete cursor[leaf];
            } else {
                cursor[leaf] = value;
            }

            const patch = fromNestedAgentConfig(nested);
            await updateConfig({
                configId: agentConfigId,
                provider: patch.provider,
                modelId: patch.modelId,
                systemPrompt: patch.systemPrompt,
                temperature: patch.temperature,
                maxTokens: patch.maxTokens,
                maxTurns: patch.maxTurns,
                outputFormat: patch.outputFormat,
                providerOptions: patch.providerOptions,
                memoryToolEnabled: patch.memoryToolEnabled,
                searchToolEnabled: patch.searchToolEnabled,
                searchToolConfig: patch.searchToolConfig,
                extraConfig: patch.extraConfig,
            });
        },
        [agentConfigId, agentConfig, updateConfig],
    );

    return {
        agentConfigId,
        agentConfig,
        updateBranch,
    };
}
