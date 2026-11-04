import { flattenFramedNodes } from "@/app/lib/canvasFrameNodes";
import type { ProposedNode } from "@/app/lib/copilotActions";
import { NODE_HEIGHT } from "@broods/convex/model/canvasLayout";
import type { Edge, Node } from "@xyflow/react";

const COLUMN_GAP = 240;
const ROW_GAP = NODE_HEIGHT + 40;
const INERT = { deletable: false, focusable: false, selectable: false };

export interface ProposedNodeData extends Record<string, unknown> {
  failed: boolean;
  kind: ProposedNode["kind"];
  label: string;
}

/** The canvas with a proposal drawn on: added nodes dashed, removed ones dimmed. */
export function withProposal(
  nodes: Node[],
  edges: Edge[],
  proposed: readonly ProposedNode[],
  failed: boolean,
): { edges: Edge[]; nodes: Node[] } {
  if (proposed.length === 0) return { edges: edges, nodes: nodes };
  const removed = new Set(
    proposed
      .filter((node) => node.change === "remove")
      .map((node) => `${node.kind}:${node.name}`),
  );
  const shown = nodes.map((node) =>
    removed.has(`${node.type}:${String(node.data.label)}`)
      ? {
          ...node,
          data: { ...node.data, proposal: failed ? "failed" : "remove" },
        }
      : node,
  );

  // Positions are absolute here: a framed member's is relative to its frame.
  const flat = flattenFramedNodes(nodes);
  const byName = new Map(
    flat.map((node) => [String(node.data.label), node.position]),
  );
  const right = Math.max(0, ...flat.map((node) => node.position.x));
  const top = Math.min(0, ...flat.map((node) => node.position.y));
  const stacked = new Map<string, number>();
  const ghosts: Array<{ connectTo?: string; node: Node }> = [];
  for (const node of proposed) {
    if (node.change !== "add" || byName.has(node.name)) continue;
    const anchor = node.connectTo ?? "";
    const row = stacked.get(anchor) ?? 0;
    stacked.set(anchor, row + 1);
    const at = byName.get(anchor) ?? { x: right, y: top };
    const position = { x: at.x + COLUMN_GAP, y: at.y + row * ROW_GAP };
    byName.set(node.name, position);
    ghosts.push({
      connectTo: node.connectTo,
      node: {
        ...INERT,
        connectable: false,
        data: { failed: failed, kind: node.kind, label: node.name },
        draggable: false,
        id: `proposed:${node.name}`,
        position: position,
        type: "proposed",
      },
    });
  }

  // Edges once every ghost is placed, so one may connect to a ghost listed after it.
  const all = [...nodes, ...ghosts.map(({ node }) => node)];
  const ghostEdges = ghosts.flatMap(({ connectTo, node }): Edge[] => {
    const target = all.find((other) => other.data.label === connectTo);
    if (!target) return [];
    const targetKind =
      target.type === "proposed" ? target.data.kind : target.type;
    const fromTarget = node.data.kind !== "agent" && targetKind === "agent";

    return [
      {
        ...INERT,
        id: `${node.id}:edge`,
        source: fromTarget ? target.id : node.id,
        style: {
          stroke: failed
            ? "var(--color-destructive)"
            : "var(--color-canvas-mount)",
          strokeDasharray: "4 3",
        },
        target: fromTarget ? node.id : target.id,
        type: "simplebezier",
      },
    ];
  });

  return {
    edges: [...edges, ...ghostEdges],
    nodes: [...shown, ...ghosts.map(({ node }) => node)],
  };
}
