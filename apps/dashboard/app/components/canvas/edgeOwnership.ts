import { isCliEdgeId } from "@broods/convex/model/canvasFrames";
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
 * Whether code owns an edge, so the canvas locks it: its id names a `broods/`
 * endpoint, or both its ends are code-managed (CLI or API). A code-managed
 * agent ignores canvas edits to its wiring, so such an edge can't be drawn by
 * hand either.
 */
export function isCodeManagedEdge(
  edge: Pick<Edge, "id" | "source" | "target">,
  managedByOf: (nodeId: string) => unknown,
): boolean {
  return (
    isCliEdgeId(edge.id) ||
    (isCodeManagedOwner(managedByOf(edge.source)) &&
      isCodeManagedOwner(managedByOf(edge.target)))
  );
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
