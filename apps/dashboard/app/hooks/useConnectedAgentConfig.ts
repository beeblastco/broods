"use client";

import type { AgentProvider } from "@/app/components/side-panel/DetailsTab";
import {
  fromNestedAgentConfig,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { applyAgentConfigUpdate } from "@/app/lib/agentConfigOptimistic";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useStore } from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef } from "react";

type ReactFlowState = {
  edges: Array<{ source: string; target: string }>;
  nodeLookup: Map<string, { type?: string; data?: { agentConfigId?: string } }>;
};

export interface ConnectedAgentConfig {
  agentConfigId: Id<"agentConfigs"> | undefined;
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  updateBranch: (path: ReadonlyArray<string>, value: unknown) => Promise<void>;
}

export function useConnectedAgentConfig(
  nodeId: string | undefined,
  via?: ReadonlyArray<string>,
): ConnectedAgentConfig {
  const agentConfigId = useReachableAgentConfigId(nodeId, via);

  const agentConfig = useQuery(
    api.agent.config.getById,
    agentConfigId ? { configId: agentConfigId } : "skip",
  );
  const updateConfig = useMutation(
    api.agent.config.update,
  ).withOptimisticUpdate(applyAgentConfigUpdate);

  // Writes queue on the freshest config: each re-projects the whole config, so one built on
  // a stale reactive snapshot would undo the edit before it.
  const latestConfig = useRef<FlatAgentConfig | null | undefined>(
    agentConfig as FlatAgentConfig | undefined,
  );
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- mirrors the Convex query into a ref
  useEffect(() => {
    latestConfig.current = agentConfig as FlatAgentConfig | undefined;
  }, [agentConfig]);
  const writeChain = useRef<Promise<void>>(Promise.resolve());

  const updateBranch = useCallback(
    (path: ReadonlyArray<string>, value: unknown) => {
      if (!agentConfigId || path.length === 0) {
        return writeChain.current;
      }

      const run = async (): Promise<void> => {
        const base = latestConfig.current;
        if (!base) {
          return;
        }

        // toNestedAgentConfig returns branches by reference into the Convex-cached document.
        const nested = structuredClone(toNestedAgentConfig(base));
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
    agentConfigId: agentConfigId,
    agentConfig: agentConfig,
    updateBranch: updateBranch,
  };
}

export function useReachableAgentConfigId(
  nodeId: string | undefined,
  via?: ReadonlyArray<string>,
): Id<"agentConfigs"> | undefined {
  return useStore(
    useCallback(
      (state: unknown) =>
        findReachableAgentConfigId(state as ReactFlowState, nodeId, via),
      [nodeId, via],
    ),
  ) as Id<"agentConfigs"> | undefined;
}

// `via` lists the node types the search may pass through: a sandbox reaches its agent
// through a workspace.
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
