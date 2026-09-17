import type { Edge } from "@xyflow/react";

/**
 * An edge synced from a `broods/` project connects two code-managed nodes,
 * encoded by a `cli-` endpoint in its id. The CLI owns these connections (it
 * recreates them on every deploy), so the dashboard locks them: no delete, no
 * reconnect, no hover-to-delete affordance.
 */
export function isCodeManagedEdgeId(id: string): boolean {
  return (
    id.startsWith("mount:cli-") ||
    id.startsWith("subagent:cli-") ||
    id.startsWith("xy-edge__cli-")
  );
}

/**
 * The edge a drawn connection becomes. A side-handle connection is a mount, or
 * a sub-agent link between two agents, with its handles encoded in the id so
 * they survive the saved layout; any other keeps React Flow's own id.
 */
export function connectionEdge(
  connection: Pick<Edge, "source" | "sourceHandle" | "target" | "targetHandle">,
  sourceIsAgent: boolean,
): Edge {
  const { source, sourceHandle, target, targetHandle } = connection;
  const ends = {
    source: source,
    sourceHandle: sourceHandle,
    target: target,
    targetHandle: targetHandle,
  };
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
 * True for an ownership marker whose resource is managed by code, either a
 * `broods/` project (`"cli"`) or the account REST API (`"api"`). Both are
 * re-synced from their source of truth, so the dashboard locks them.
 */
export function isCodeManagedOwner(managedBy: unknown): boolean {
  return managedBy === "cli" || managedBy === "api";
}

/**
 * Whether code owns an edge, by the one rule the canvas locks with and the
 * next deploy prunes by: its id names a code endpoint, or both its ends are
 * code-managed. A code-managed agent ignores canvas edits to its wiring, so
 * such an edge can't be drawn by hand either.
 */
export function isCodeOwnedEdge(
  edge: Pick<Edge, "id" | "source" | "target">,
  managedByOf: (nodeId: string) => unknown,
): boolean {
  return (
    isCodeManagedEdgeId(edge.id) ||
    (isCodeManagedOwner(managedByOf(edge.source)) &&
      isCodeManagedOwner(managedByOf(edge.target)))
  );
}

export function isCodeManagedEdge(edge: {
  id: string;
  data?: unknown;
}): boolean {
  if (isCodeManagedEdgeId(edge.id)) return true;
  if (!edge.data || typeof edge.data !== "object") return false;

  return isCodeManagedOwner((edge.data as { managedBy?: string }).managedBy);
}

function isSideHandle(handle: string | null | undefined): boolean {
  return handle === "left" || handle === "right";
}
