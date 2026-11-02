import { workspaceSandboxIds } from "@broods/convex/model/canvasFrames";
import type { Edge, Node } from "@xyflow/react";

// Outward edges only (mounts both ways), so a resource never lights its agent; the walk
// stops at a non-seed agent, whose own resources belong to it.
export function focusedNodeIds(
  nodes: readonly Node[],
  edges: readonly Edge[],
  seeds: readonly string[],
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out = adjacency(nodes, edges);

  const reachable = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!seeds.includes(current) && byId.get(current)?.type === "agent") {
      continue;
    }
    for (const next of out.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  return reachable;
}

function adjacency(
  nodes: readonly Node[],
  edges: readonly Edge[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = out.get(from);
    if (list) list.push(to);
    else out.set(from, [to]);
  };

  for (const edge of edges) {
    link(edge.source, edge.target);
    if (edge.type === "mount") link(edge.target, edge.source);
  }
  // An inherited mount has no stored edge but is drawn, so walk it too.
  for (const [workspaceId, state] of workspaceSandboxIds(nodes, edges)) {
    if (state.kind !== "inherited") continue;
    for (const sandboxId of state.sandboxIds) {
      link(workspaceId, sandboxId);
      link(sandboxId, workspaceId);
    }
  }

  return out;
}
