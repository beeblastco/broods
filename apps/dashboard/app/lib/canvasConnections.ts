/**
 * The rule that decides whether an edge the user drags is allowed. React Flow
 * calls it while the line is still in the air, to highlight or refuse the drop,
 * and the canvas calls nothing else before saving the edge.
 *
 * Pure and exported on purpose: the rules are subtle enough that the
 * `/ui-gallery` connection fixture drives this exact function, so a spec can
 * drag a real edge and get the real answer.
 */
import {
  connectionEdge,
  isCodeManagedEdge,
  isSideHandle,
} from "@/app/components/canvas/edgeOwnership";
import {
  introducedRuntimeRefsProblem,
  type FlatGraph,
} from "@/app/lib/canvasFrameEdits";
import type { Connection, Edge } from "@xyflow/react";

/** The graph a connection is judged against. */
export type ConnectionGraph = Pick<FlatGraph, "edges" | "nodes">;

/**
 * Whether the canvas accepts this connection. Refused when either end is
 * missing, when the two ends already share an edge, when code owns the wiring,
 * when only one end sits on a side handle, or when the edge would leave an
 * agent with a workspace mounted on a sandbox that is not its first.
 */
export function isValidCanvasConnection(
  graph: ConnectionGraph,
  connection: Connection | Edge,
): boolean {
  if (connection.source === connection.target) return false;

  const srcNode = graph.nodes.find((node) => node.id === connection.source);
  const tgtNode = graph.nodes.find((node) => node.id === connection.target);
  // Frames are drawn, not stored, so nothing connects to one.
  if (!srcNode || !tgtNode) return false;
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
  if (duplicate) return false;
  // Code owns this wiring: the agent would ignore the edge, the canvas would
  // lock it, and the next deploy would remove it.
  if (
    isCodeManagedEdge(
      connectionEdge(connection, srcNode.type === "agent"),
      (nodeId): unknown =>
        (nodeId === srcNode.id ? srcNode : tgtNode).data.managedBy,
    )
  ) {
    return false;
  }

  // Side handles serve mounts (workspace↔sandbox) and subagent links
  // (agent↔agent) only; those pairs must use the sides on BOTH ends, never the
  // top/bottom handles. A half-side edge would encode a null handle into its id
  // and fail to hydrate after a reload.
  const sourceIsSide = isSideHandle(connection.sourceHandle);
  const targetIsSide = isSideHandle(connection.targetHandle);
  if (sourceIsSide || targetIsSide) {
    // A mount that would back a workspace from an agent's later sandbox is
    // refused too.
    return (
      sourceIsSide &&
      targetIsSide &&
      (isAgentPair ||
        (isMountPair && !wouldStrandAWorkspace(graph, connection, "mount")))
    );
  }
  if (isMountPair || isAgentPair) return false;

  return !wouldStrandAWorkspace(graph, connection, undefined);
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
 * Whether adding this edge puts a workspace on a sandbox that is not its
 * agent's first, which the config API refuses. A problem the graph already had
 * is not this edge's to answer for.
 */
function wouldStrandAWorkspace(
  graph: ConnectionGraph,
  connection: Connection | Edge,
  type: "mount" | undefined,
): boolean {
  const candidate: Edge = {
    id: type === undefined ? "candidate" : "mount:candidate",
    source: connection.source,
    target: connection.target,
    type: type,
  };

  return (
    introducedRuntimeRefsProblem(
      { edges: graph.edges, nodes: graph.nodes },
      { edges: [...graph.edges, candidate], nodes: graph.nodes },
    ) !== null
  );
}
