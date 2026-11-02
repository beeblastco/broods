import {
  connectionEdge,
  isCodeManagedEdge,
  isCodeManagedOwner,
  isSideHandle,
} from "@/app/components/canvas/edgeOwnership";
import {
  cardLabel,
  introducedRuntimeRefsProblem,
  type FlatGraph,
} from "@/app/lib/canvasFrameEdits";
import { runtimeRefsProblemText } from "@/app/lib/canvasRuntimeRefs";
import type { Connection, Edge } from "@xyflow/react";

export type ConnectionGraph = Pick<FlatGraph, "edges" | "nodes">;

export function connectionRefusal(
  graph: ConnectionGraph,
  connection: Connection | Edge,
): string | null {
  if (connection.source === connection.target) {
    return "A card can't connect to itself.";
  }

  const srcNode = graph.nodes.find((node) => node.id === connection.source);
  const tgtNode = graph.nodes.find((node) => node.id === connection.target);
  // Frames are drawn, not stored, so nothing connects to one.
  if (!srcNode || !tgtNode) {
    return "A group can't take a connection. Open it and connect to a card inside.";
  }
  const srcLabel = cardLabel(srcNode);
  const tgtLabel = cardLabel(tgtNode);
  const isMountPair =
    (srcNode.type === "workspace" || srcNode.type === "sandbox") &&
    (tgtNode.type === "workspace" || tgtNode.type === "sandbox");
  const isAgentPair = srcNode.type === "agent" && tgtNode.type === "agent";

  // Subagent links are directional: A→B and B→A coexist.
  const duplicate = isAgentPair
    ? graph.edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target,
      )
    : hasEdgeBetween(graph.edges, connection.source, connection.target);
  if (duplicate) return `${srcLabel} is already connected to ${tgtLabel}.`;
  if (
    isCodeManagedEdge(
      connectionEdge(connection, srcNode.type === "agent"),
      (nodeId) => (nodeId === srcNode.id ? srcNode : tgtNode),
    )
  ) {
    const owned = [srcNode, tgtNode]
      .filter((node) => isCodeManagedOwner(node.data.managedBy))
      .map(cardLabel);

    return `Code manages ${owned.length > 0 ? owned.join(" and ") : srcLabel}. Add this link there and deploy.`;
  }

  const wrongHandles = handleRefusal(
    connection,
    isAgentPair ? "subagent" : isMountPair ? "mount" : "service",
    srcLabel,
    tgtLabel,
  );
  if (wrongHandles !== null || isAgentPair) return wrongHandles;

  const problem = introducedRuntimeRefsProblem(
    { edges: graph.edges, nodes: graph.nodes },
    {
      edges: [
        ...graph.edges,
        {
          id: isMountPair ? "mount:candidate" : "candidate",
          source: connection.source,
          target: connection.target,
          type: isMountPair ? "mount" : undefined,
        },
      ],
      nodes: graph.nodes,
    },
  );

  return problem ? `${runtimeRefsProblemText(problem)}.` : null;
}

export function hasEdgeBetween(
  edges: readonly Edge[],
  a: string,
  b: string,
): boolean {
  return edges.some(
    (edge) =>
      (edge.source === a && edge.target === b) ||
      (edge.source === b && edge.target === a),
  );
}

// A half-side edge encodes a null handle into its id and fails to hydrate after a reload.
function handleRefusal(
  connection: Connection | Edge,
  kind: "mount" | "service" | "subagent",
  srcLabel: string,
  tgtLabel: string,
): string | null {
  const sourceIsSide = isSideHandle(connection.sourceHandle);
  const targetIsSide = isSideHandle(connection.targetHandle);
  if (kind === "service") {
    return sourceIsSide || targetIsSide
      ? "Side handles link two agents or mount a workspace. Connect a service from its agent's bottom to the card's top."
      : null;
  }
  if (sourceIsSide && targetIsSide) return null;

  return kind === "mount"
    ? `Mount ${srcLabel} on ${tgtLabel} from side handle to side handle.`
    : `Link ${srcLabel} to ${tgtLabel} from side handle to side handle.`;
}
