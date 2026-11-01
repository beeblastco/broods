import { edgeKind, isCliEdgeId } from "@broods/convex/model/canvasFrames";
import type { LayoutEdge, LayoutNode } from "@broods/convex/model/canvasLayout";
import type { Edge } from "@xyflow/react";

/**
 * Side-handle connections encode their handles in the id so they survive the saved layout;
 * others copy React Flow's id format (its `getEdgeId` is not exported).
 */
export function connectionEdge(
  connection: Pick<Edge, "source" | "sourceHandle" | "target" | "targetHandle">,
  sourceIsAgent: boolean,
): Edge {
  const ends = {
    source: connection.source,
    sourceHandle: connection.sourceHandle,
    target: connection.target,
    targetHandle: connection.targetHandle,
  };
  const { source, sourceHandle, target, targetHandle } = ends;
  if (!isSideHandle(sourceHandle) && !isSideHandle(targetHandle)) {
    return {
      ...ends,
      id: `xy-edge__${source}${sourceHandle ?? ""}-${target}${targetHandle ?? ""}`,
    };
  }
  const kind = sourceIsAgent ? "subagent" : "mount";

  return {
    ...ends,
    animated: false,
    id: `${kind}:${source}-${sourceHandle}-${target}-${targetHandle}`,
    type: kind,
  };
}

/**
 * Ownership sits on the one end whose config holds the link, so a mount reads the same
 * whichever way it was dragged. The id prefix is the fallback once both ends left the graph.
 */
export function isCodeManagedEdge(
  edge: LayoutEdge,
  nodeOf: (nodeId: string) => LayoutNode | undefined,
): boolean {
  const owner = owningEnd(edge, nodeOf(edge.source), nodeOf(edge.target));

  return owner
    ? isCodeManagedOwner(owner.data.managedBy)
    : isCliEdgeId(edge.id);
}

export function isCodeManagedOwner(managedBy: unknown): boolean {
  return managedBy === "cli" || managedBy === "api";
}

export function isSideHandle(handle: string | null | undefined): boolean {
  return handle === "left" || handle === "right";
}

/**
 * An agent's manifest lists its services and sub-agents (the parent is the source), so the
 * agent end owns those links; `cliSyncCanvas` draws a mount from its workspace, which owns it.
 */
function owningEnd(
  edge: LayoutEdge,
  source: LayoutNode | undefined,
  target: LayoutNode | undefined,
): LayoutNode | undefined {
  const owner = edgeKind(edge) === "mount" ? "workspace" : "agent";
  if (source?.type === owner) return source;

  return target?.type === owner ? target : undefined;
}
