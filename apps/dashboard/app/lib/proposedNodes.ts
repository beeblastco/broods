import type { DockProposal, ProposedNode } from "@/app/lib/copilotActions";
import { NODE_HEIGHT } from "@broods/convex/model/canvasLayout";
import type { Edge, Node } from "@xyflow/react";

const NONE: readonly ProposedNode[] = [];
const COLUMN_GAP = 240;
const ROW_GAP = NODE_HEIGHT + 40;
const DRAWN: ReadonlySet<DockProposal["apply"]["phase"]> = new Set([
  "applying",
  "failed",
  "proposed",
]);

export interface ProposedNodeData extends Record<string, unknown> {
  failed: boolean;
  kind: ProposedNode["kind"];
  label: string;
}

/** The architecture change a proposal makes: the one source the canvas draws it from. */
export function proposedNodes(
  proposal: DockProposal | null,
): readonly ProposedNode[] {
  if (!proposal || !DRAWN.has(proposal.apply.phase)) return NONE;

  return proposal.nodes.length > 0 ? proposal.nodes : NONE;
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
  const ghostEdges: Edge[] = [];
  for (const node of proposed) {
    if (node.change !== "add" || byName.has(node.name)) continue;
    const anchor = node.connectTo ?? "";
    const row = stacked.get(anchor) ?? 0;
    stacked.set(anchor, row + 1);
    const at = byName.get(anchor) ?? { x: right, y: top };
    const id = `proposed:${node.name}`;
    const position = { x: at.x + COLUMN_GAP, y: at.y + row * ROW_GAP };
    ghosts.push({
      connectable: false,
      data: { failed: failed, kind: node.kind, label: node.name },
      deletable: false,
      draggable: false,
      focusable: false,
      id: id,
      position: position,
      selectable: false,
      type: "proposed",
    });
    byName.set(node.name, position);
    const target = nodes.find((other) => other.data.label === node.connectTo);
    if (
      !target &&
      !ghosts.some((ghost) => ghost.data.label === node.connectTo)
    ) {
      continue;
    }
    const targetId = target?.id ?? `proposed:${node.connectTo}`;
    const fromTarget = node.kind !== "agent" && target?.type === "agent";
    ghostEdges.push({
      deletable: false,
      focusable: false,
      id: `${id}:edge`,
      selectable: false,
      source: fromTarget ? targetId : id,
      style: {
        stroke: failed
          ? "var(--color-destructive)"
          : "var(--color-canvas-mount)",
        strokeDasharray: "4 3",
      },
      target: fromTarget ? id : targetId,
      type: "simplebezier",
    });
  }

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
