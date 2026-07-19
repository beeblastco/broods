"use client";

/**
 * Resolves the agent config wired to a non-agent canvas node so its side-panel
 * tabs can edit a slice of that agent's nested config (workspace, tools.X,
 * skills.X, workspace.sandbox, etc.).
 */
import type { AgentProvider } from "@/app/components/side-panel/DetailsTab";
import {
  fromNestedAgentConfig,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { applyAgentConfigUpdate } from "@/app/lib/agentConfigOptimistic";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useStore } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef } from "react";

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
  const updateConfig = useMutation(api.agentConfig.update).withOptimisticUpdate(
    applyAgentConfigUpdate,
  );

  // Keep the freshest config and serialize writes so chained edits never build
  // on a stale reactive snapshot (each branch edit re-projects the whole config).
  const latestConfig = useRef<FlatAgentConfig | null | undefined>(
    agentConfig as FlatAgentConfig | undefined,
  );
  useEffect(() => {
    latestConfig.current = agentConfig as FlatAgentConfig | undefined;
  }, [agentConfig]);
  const writeChain = useRef<Promise<void>>(Promise.resolve());

  /**
   * Writes a JSON value at the given branch path of the nested AgentConfig and
   * persists the projected flat patch to Convex. Writes are queued so a burst of
   * edits applies sequentially against the latest config rather than clobbering.
   */
  const updateBranch = useCallback(
    (path: ReadonlyArray<string>, value: unknown) => {
      if (!agentConfigId || path.length === 0) {
        return writeChain.current;
      }

      const run = async () => {
        const base = latestConfig.current;
        if (!base) {
          return;
        }

        const nested = toNestedAgentConfig(base);
        let cursor: Record<string, unknown> = nested as Record<string, unknown>;
        for (let i = 0; i < path.length - 1; i += 1) {
          const key = path[i];
          const next = cursor[key];
          if (
            typeof next !== "object" ||
            next === null ||
            Array.isArray(next)
          ) {
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
        // Advance the local snapshot so the next queued write sees this change.
        latestConfig.current = { ...base, ...patch };
        const { provider, ...rest } = patch;
        await updateConfig({
          configId: agentConfigId,
          ...rest,
          provider: provider as AgentProvider | undefined,
        });
      };

      writeChain.current = writeChain.current.then(run, run);

      return writeChain.current;
    },
    [agentConfigId, updateConfig],
  );

  return {
    agentConfigId,
    agentConfig,
    updateBranch,
  };
}
