import type { ProposedNode } from "@/app/lib/copilotActions";
import { NODE_HEIGHT } from "@broods/convex/model/canvasLayout";
import type { Edge, Node } from "@xyflow/react";

const COLUMN_GAP = 240;
const ROW_GAP = NODE_HEIGHT + 40;

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
      .map((node) => nodeKey(node.kind, node.name)),
  );
  const shown = nodes.map((node) =>
    removed.has(nodeKey(node.type, node.data.label))
      ? {
          ...node,
          data: { ...node.data, proposal: failed ? "failed" : "remove" },
          style: { ...node.style, opacity: 0.5 },
        }
      : node,
  );

  const byName = new Map(
    nodes.map((node) => [String(node.data.label), absolute(node, nodes)]),
  );
  const right = Math.max(0, ...[...byName.values()].map((at) => at.x));
  const top = Math.min(0, ...[...byName.values()].map((at) => at.y));
  const stacked = new Map<string, number>();
  const ghosts: Node[] = [];
  for (const node of proposed) {
    if (node.change !== "add" || byName.has(node.name)) continue;
    const anchor = node.connectTo ?? "";
    const row = stacked.get(anchor) ?? 0;
    stacked.set(anchor, row + 1);
    const at = byName.get(anchor) ?? { x: right, y: top };
    const position = { x: at.x + COLUMN_GAP, y: at.y + row * ROW_GAP };
    byName.set(node.name, position);
    ghosts.push({
      connectable: false,
      data: { failed: failed, kind: node.kind, label: node.name },
      deletable: false,
      draggable: false,
      focusable: false,
      id: `proposed:${node.name}`,
      position: position,
      selectable: false,
      type: "proposed",
    });
  }

  // Edges once every ghost is placed, so one may connect to a ghost listed after it.
  const all = [...nodes, ...ghosts];
  const ghostEdges = ghosts.flatMap((ghost): Edge[] => {
    const connectTo = proposed.find(
      (node) => node.name === ghost.data.label,
    )?.connectTo;
    const target = all.find((other) => other.data.label === connectTo);
    if (!target) return [];
    const targetKind =
      target.type === "proposed" ? target.data.kind : target.type;
    const fromTarget = ghost.data.kind !== "agent" && targetKind === "agent";

    return [
      {
        deletable: false,
        focusable: false,
        id: `${ghost.id}:edge`,
        selectable: false,
        source: fromTarget ? target.id : ghost.id,
        style: {
          stroke: failed
            ? "var(--color-destructive)"
            : "var(--color-canvas-mount)",
          strokeDasharray: "4 3",
        },
        target: fromTarget ? ghost.id : target.id,
        type: "simplebezier",
      },
    ];
  });

  return { edges: [...edges, ...ghostEdges], nodes: [...shown, ...ghosts] };
}

// A framed member's position is relative to its frame.
function absolute(
  node: Node,
  nodes: readonly Node[],
): { x: number; y: number } {
  const parent = node.parentId
    ? nodes.find((other) => other.id === node.parentId)
    : undefined;

  return {
    x: node.position.x + (parent?.position.x ?? 0),
    y: node.position.y + (parent?.position.y ?? 0),
  };
}

function nodeKey(kind: string | undefined, name: unknown): string {
  return `${kind ?? ""}:${String(name)}`;
}
