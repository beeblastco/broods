/**
 * The rule that decides whether an edge the user drags is allowed, and the
 * sentence that says why not. React Flow asks while the line is still in the
 * air, the canvas shows the reason at the top, and nothing else is checked
 * before the edge is saved.
 *
 * Pure and exported on purpose: the rules are subtle enough that the
 * `/ui-gallery` connection fixture drives this exact function, so a spec can
 * drag a real edge and get the real answer.
 */
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

/** The graph a connection is judged against. */
export type ConnectionGraph = Pick<FlatGraph, "edges" | "nodes">;

/**
 * Why the canvas refuses this connection, as the sentence the refusal notice
 * shows, or null when it is accepted. Refused when either end is missing, when
 * the two ends already share an edge, when code owns the wiring, when only one
 * end sits on a side handle, or when the edge would leave an agent with a
 * workspace mounted on a sandbox that is not its first.
 */
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

  // Subagent links are directional (A→B and B→A coexist), so dedupe by
  // direction; every other pair allows a single edge either way.
  const duplicate = isAgentPair
    ? graph.edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target,
      )
    : hasEdgeBetween(graph.edges, connection.source, connection.target);
  if (duplicate) return `${srcLabel} is already connected to ${tgtLabel}.`;
  // Code owns this wiring: the agent would ignore the edge, the canvas would
  // lock it, and the next deploy would remove it.
  if (
    isCodeManagedEdge(
      connectionEdge(connection, srcNode.type === "agent"),
      (nodeId) => (nodeId === srcNode.id ? srcNode : tgtNode),
    )
  ) {
    // Names the ends code owns, which covers the one that owns the link. The
    // id fallback can lock an edge with neither end owned, so name the source
    // when nothing else is there to name.
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
  // A subagent link carries no runtime refs, so its handles are its only rule.
  if (wrongHandles !== null || isAgentPair) return wrongHandles;

  // An edge that would back a workspace from an agent's later sandbox is
  // refused too. A problem the graph already had is not this edge's to answer for.
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

/** Whether these two nodes already share an edge, in either direction. */
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

/**
 * Side handles serve mounts (workspace↔sandbox) and subagent links
 * (agent↔agent) only; those pairs must use the sides on BOTH ends, never the
 * top/bottom handles. A half-side edge would encode a null handle into its id
 * and fail to hydrate after a reload.
 */
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
