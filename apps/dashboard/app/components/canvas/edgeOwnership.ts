import { edgeKind, isCliEdgeId } from "@broods/convex/model/canvasFrames";
import type { LayoutEdge, LayoutNode } from "@broods/convex/model/canvasLayout";
import type { Edge } from "@xyflow/react";

/**
 * The edge a drawn connection becomes. A side-handle connection is a mount, or
 * a sub-agent link between two agents, with its handles encoded in the id so
 * they survive the saved layout; any other gets React Flow's own id (its
 * `getEdgeId`, which `@xyflow/react` does not export).
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
 * Whether code owns an edge, so the canvas locks it and refuses to draw it by
 * hand. Ownership sits on the one end whose config holds the link, which
 * {@link owningEnd} picks. Asking about one end rather than both is what makes
 * an `api-` agent's service edge lock the way a `cli-` one does, and what
 * makes a mount read the same whichever way it was dragged. The id prefix
 * stays as a fallback for an edge whose ends have left the graph.
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

/**
 * True for an ownership marker whose resource is managed by code, either a
 * `broods/` project (`"cli"`) or the account REST API (`"api"`). Both are
 * re-synced from their source of truth, so the dashboard locks them.
 */
export function isCodeManagedOwner(managedBy: unknown): boolean {
  return managedBy === "cli" || managedBy === "api";
}

/** A side handle, where mounts and sub-agent links attach. */
export function isSideHandle(handle: string | null | undefined): boolean {
  return handle === "left" || handle === "right";
}

/**
 * The end whose config holds `edge`. An agent's manifest lists its sandboxes,
 * workspaces, skills and sub-agents, so the agent end owns a service or
 * sub-agent link, and the parent is the source of a sub-agent link. A mount is
 * the `sandbox` on one of those workspace refs, and `cliSyncCanvas` draws it
 * from the workspace, so the workspace end owns it.
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
