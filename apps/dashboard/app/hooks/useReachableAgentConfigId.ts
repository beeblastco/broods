"use client";

import type { Id } from "@broods/convex/_generated/dataModel";
import { useStore } from "@xyflow/react";
import { useCallback } from "react";

type ReactFlowState = {
  edges: Array<{ source: string; target: string }>;
  nodeLookup: Map<string, { type?: string; data?: { agentConfigId?: string } }>;
};

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
