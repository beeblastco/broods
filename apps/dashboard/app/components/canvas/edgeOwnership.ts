/**
 * An edge synced from a `filthypanty/` project connects two code-managed nodes,
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

/** Return true when an edge is explicitly marked as code-managed. */
export function isCodeManagedEdge(edge: {
  id: string;
  data?: unknown;
}): boolean {
  if (isCodeManagedEdgeId(edge.id)) return true;
  if (!edge.data || typeof edge.data !== "object") return false;

  return (edge.data as { managedBy?: string }).managedBy === "cli";
}
