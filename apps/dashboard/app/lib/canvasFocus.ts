/**
 * Focus mode's reach: which cards stay lit when one is selected. Pure, so the
 * rule is testable without a canvas around it. `Canvas` dims everything else.
 */
import { workspaceSandboxIds } from "@broods/convex/model/canvasFrames";
import type { Edge, Node } from "@xyflow/react";

/**
 * Every node the seeds connect TO, seeds included. Edges are followed outward
 * only, so a resource never lights up the agent wired into it; mount edges flow
 * both ways, so either end of a workspace↔sandbox link reveals the other. The
 * walk stops at any agent that is not a seed: a subagent callee lights up, its
 * own resources stay dim because they belong to the callee.
 */
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

/** Directed "connects to", keyed by node id. */
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
  // A mount a workspace inherits has no stored edge: the frame layer draws it
  // from the agent's first sandbox. Walk it here too, or selecting either end
  // dims a link the board is drawing.
  for (const [workspaceId, state] of workspaceSandboxIds(nodes, edges)) {
    if (state.kind !== "inherited") continue;
    for (const sandboxId of state.sandboxIds) {
      link(workspaceId, sandboxId);
      link(sandboxId, workspaceId);
    }
  }

  return out;
}
