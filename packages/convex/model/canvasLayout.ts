/**
 * Deterministic canvas auto-layout, shared by the dashboard, the CLI sync and
 * the account API sync so every writer draws the same picture.
 *
 * The tidy layout works in card-sized cells, so its columns and rows line up
 * across the whole board. Drags and manual adds are finer: they snap to the
 * background dot grid and only step aside when they would cover another card.
 *
 * Each agent owns a cluster: the agent card sits centred above a block of
 * typed columns holding the services only that agent uses. Sub-agents follow
 * their parent, so the side-handle link between them stays short. Services
 * more than one agent reaches drop to a shared lane under the clusters, and
 * services no agent reaches to an unconnected lane below that. A mount edge
 * ties its two cards together: an agent that reaches one reaches the other, so
 * a mounted pair always lands in the same cluster or lane.
 *
 * Sandbox, workspace and MCP columns stack frames rather than cards: each
 * frame starts on a cell, its members fill its slots, and it claims as many
 * rows as its expanded height needs. Frames come from `canvasFrames.ts`, so
 * the dashboard reads back the same groups the layout packed.
 */

import type { CanvasNode } from "../canvas";
import {
  agentOwners,
  compareByLabel,
  deriveCanvasFrames,
  edgeKind,
  frameMemberPositions,
  frameSize,
  type CanvasFrame,
  type McpTransportsByNode,
} from "./canvasFrames";

/** Card box, matching `w-44 min-h-24` on the node shell in `BaseNode.tsx`. */
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 96;

/** Background dot pitch. Drags snap to it, and cell sizes are multiples of it. */
export const GRID = 24;

/** One tidy-layout cell: a card plus the gap to the next one. */
export const CELL_WIDTH = NODE_WIDTH + 40;
export const CELL_HEIGHT = NODE_HEIGHT + 48;

/** Empty cells between two agent clusters, and above each lane. */
const CLUSTER_GAP_COLUMNS = 1;
const LANE_GAP_ROWS = 1;

/** Clearance a nudged card keeps from the cards it stepped around. */
const NODE_MARGIN = 16;

/** How far {@link findFreePosition} steps out before giving up, in dot-grid steps. */
const MAX_NUDGE_RINGS = 48;

/**
 * Column order for an agent's services, mirroring the dashboard's "Add service"
 * menu. Sandbox and workspace stay adjacent so the mount edge between them
 * stays short. Exhaustive over the node types on purpose: adding one to
 * `canvasNodeValidator` without giving it a column is a compile error here.
 */
const SERVICE_COLUMN_ORDER: Record<
  Exclude<CanvasNode["type"], "agent">,
  number
> = {
  database: 0,
  sandbox: 1,
  workspace: 2,
  skill: 3,
  mcp: 4,
};

const COLUMN_RANKS: ReadonlyMap<string, number> = new Map(
  Object.entries(SERVICE_COLUMN_ORDER),
);

/** One stage's graph, split into the groups the layout places separately. */
type CanvasGraph = {
  /** Ids of every agent node, for the ownership and parent tests. */
  agentIds: Set<string>;
  agents: LayoutNode[];
  /** Services exactly one agent reaches, keyed by that agent's id. */
  exclusiveServices: Map<string, LayoutNode[]>;
  /** Services no agent reaches, the cards the canvas renders as unconnected. */
  orphanServices: LayoutNode[];
  /** Sub-agent parent, keyed by the child agent's id. */
  parentAgentId: Map<string, string>;
  /** Services more than one agent reaches. */
  sharedServices: LayoutNode[];
};

/** One item a column stacks: a frame and its members, or a lone card. */
type ColumnItem = { frame: CanvasFrame } | { node: LayoutNode };

/** A block of typed columns, and the cells it occupies. */
type LayoutBlock = {
  /** Row below the lowest placed card, or the origin row when empty. */
  bottomRow: number;
  columns: number;
  positions: Map<string, LayoutPosition>;
};

/** The subset of a canvas edge the layout reads. */
export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  /** Set on dashboard edges; the persisted form carries the kind in `id`. */
  type?: string | undefined;
};

/**
 * The subset of a canvas node the layout reads. Both the dashboard's ReactFlow
 * nodes and the persisted `CanvasNode` satisfy it structurally.
 */
export type LayoutNode = {
  id: string;
  type?: string | undefined;
  data: Record<string, unknown>;
};

export type LayoutPosition = CanvasNode["position"];

/** A box already on the board: a card or a frame. */
export type LayoutRect = LayoutPosition & { height: number; width: number };

/** Overlay new positions by node id, leaving every other node field untouched. */
export function applyPositions<
  T extends LayoutNode & { position: LayoutPosition },
>(nodes: readonly T[], positions: ReadonlyMap<string, LayoutPosition>): T[] {
  return nodes.map((node) => {
    const position = positions.get(node.id);

    return position ? { ...node, position: position } : node;
  });
}

export function applyTidyLayout<
  T extends LayoutNode & { position: LayoutPosition },
>(
  nodes: readonly T[],
  edges: readonly LayoutEdge[],
  mcpTransports: McpTransportsByNode,
): T[] {
  return applyPositions(nodes, tidyCanvasLayout(nodes, edges, mcpTransports));
}

/**
 * Nearest dot-grid point to `desired` whose card clears every occupied box.
 * Manual adds and drag drops land right there, and only step aside when they
 * would cover a card or frame: below first, then right, left, above, then out.
 */
export function findFreePosition(
  desired: LayoutPosition,
  occupied: readonly LayoutRect[],
): LayoutPosition {
  const start = snapToGrid(desired);
  for (let ring = 0; ring <= MAX_NUDGE_RINGS; ring++) {
    for (const offset of ringOffsets(ring)) {
      const candidate = {
        x: start.x + offset.x * GRID,
        y: start.y + offset.y * GRID,
      };
      if (!occupied.some((taken) => cardOverlaps(candidate, taken))) {
        return candidate;
      }
    }
  }

  return start;
}

export function tidyCanvasLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpTransports: McpTransportsByNode,
): Map<string, LayoutPosition> {
  const graph = indexGraph(nodes, edges);
  const frames = deriveCanvasFrames(nodes, edges, mcpTransports);
  const positions = new Map<string, LayoutPosition>();
  let cursorColumn = 0;
  let deepestRow = 1;

  for (const agent of orderAgents(graph)) {
    const services = graph.exclusiveServices.get(agent.id) ?? [];
    const block = layoutBlock(services, frames, cursorColumn, 1);
    // Middle column of the block; the left one of the two when the count is even.
    positions.set(
      agent.id,
      cellPosition(cursorColumn + Math.floor((block.columns - 1) / 2), 0),
    );
    for (const [id, position] of block.positions) positions.set(id, position);
    deepestRow = Math.max(deepestRow, block.bottomRow);
    cursorColumn += block.columns + CLUSTER_GAP_COLUMNS;
  }

  const totalColumns = Math.max(cursorColumn - CLUSTER_GAP_COLUMNS, 1);
  const lanes = [
    // Centred, because a shared service belongs to no single cluster.
    { centered: true, services: graph.sharedServices },
    // Left-aligned, so unwired cards read as parked rather than part of the graph.
    { centered: false, services: graph.orphanServices },
  ];
  let laneRow = deepestRow + LANE_GAP_ROWS;

  for (const lane of lanes) {
    if (lane.services.length === 0) continue;
    const block = layoutBlock(lane.services, frames, 0, laneRow);
    const offsetX = lane.centered
      ? Math.max(0, Math.floor((totalColumns - block.columns) / 2)) * CELL_WIDTH
      : 0;
    for (const [id, position] of block.positions) {
      positions.set(id, { x: position.x + offsetX, y: position.y });
    }
    laneRow = block.bottomRow + LANE_GAP_ROWS;
  }

  return positions;
}

/** Whether a card at `card` comes within the margin of `box`. */
function cardOverlaps(card: LayoutPosition, box: LayoutRect): boolean {
  return (
    card.x < box.x + box.width + NODE_MARGIN &&
    box.x < card.x + NODE_WIDTH + NODE_MARGIN &&
    card.y < box.y + box.height + NODE_MARGIN &&
    box.y < card.y + NODE_HEIGHT + NODE_MARGIN
  );
}

/** Top-left corner of a cell. */
function cellPosition(column: number, row: number): LayoutPosition {
  return { x: column * CELL_WIDTH, y: row * CELL_HEIGHT };
}

/** Position of a service type in {@link SERVICE_COLUMN_ORDER}; unknown types sort last. */
function columnRank(type: string): number {
  return COLUMN_RANKS.get(type) ?? COLUMN_RANKS.size;
}

/**
 * A column's frames in frame order, then its lone cards by label. The node
 * types that frame never mix framed and lone cards in one block: a cluster or
 * the shared lane holds only reached services, the unconnected lane none.
 */
function columnItems(
  column: readonly LayoutNode[],
  frames: readonly CanvasFrame[],
): ColumnItem[] {
  const ids = new Set(column.map((node) => node.id));
  const framed = frames.filter((frame) =>
    frame.memberIds.some((id) => ids.has(id)),
  );
  const framedIds = new Set(framed.flatMap((frame) => frame.memberIds));

  return [
    ...framed.map((frame) => ({ frame: frame })),
    ...column
      .filter((node) => !framedIds.has(node.id))
      .map((node) => ({ node: node })),
  ];
}

/** Whole cells a frame claims: its expanded height plus the usual gap, rounded up. */
function frameRows(memberCount: number): number {
  const gap = CELL_HEIGHT - NODE_HEIGHT;

  return Math.ceil((frameSize(memberCount).height + gap) / CELL_HEIGHT);
}

function groupIntoColumns(services: readonly LayoutNode[]): LayoutNode[][] {
  const byType = new Map<string, LayoutNode[]>();
  for (const node of services) {
    const type = node.type ?? "";
    const column = byType.get(type);
    if (column) column.push(node);
    else byType.set(type, [node]);
  }

  return [...byType.entries()]
    .sort(([a], [b]) => columnRank(a) - columnRank(b) || a.localeCompare(b))
    .map(([, column]) => column.sort(compareByLabel));
}

function indexGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): CanvasGraph {
  const agents = nodes.filter((node) => node.type === "agent");
  const services = nodes.filter((node) => node.type !== "agent");
  const agentIds = new Set(agents.map((agent) => agent.id));
  const parentAgentId = new Map<string, string>();
  const ownersByService = agentOwners(nodes, edges);

  for (const edge of edges) {
    if (
      edgeKind(edge) === "subagent" &&
      agentIds.has(edge.source) &&
      agentIds.has(edge.target)
    ) {
      parentAgentId.set(edge.target, edge.source);
    }
  }

  const exclusiveServices = new Map<string, LayoutNode[]>();
  const orphanServices: LayoutNode[] = [];
  const sharedServices: LayoutNode[] = [];

  for (const service of services) {
    const owners = ownersByService.get(service.id);
    if (!owners) {
      orphanServices.push(service);
      continue;
    }
    if (owners.size > 1) {
      sharedServices.push(service);
      continue;
    }
    const [ownerId] = owners;
    const owned = exclusiveServices.get(ownerId);
    if (owned) owned.push(service);
    else exclusiveServices.set(ownerId, [service]);
  }

  return {
    agentIds: agentIds,
    agents: agents,
    exclusiveServices: exclusiveServices,
    orphanServices: orphanServices,
    parentAgentId: parentAgentId,
    sharedServices: sharedServices,
  };
}

/**
 * Place services as typed columns growing right, rows growing down, starting
 * at the given cell. An empty block still claims one column for its agent.
 */
function layoutBlock(
  services: readonly LayoutNode[],
  frames: readonly CanvasFrame[],
  originColumn: number,
  originRow: number,
): LayoutBlock {
  const columns = groupIntoColumns(services);
  const positions = new Map<string, LayoutPosition>();
  let bottomRow = originRow;

  columns.forEach((column, columnIndex) => {
    let row = originRow;
    for (const item of columnItems(column, frames)) {
      const origin = cellPosition(originColumn + columnIndex, row);
      if ("node" in item) {
        positions.set(item.node.id, origin);
        row += 1;
        continue;
      }
      const { memberIds } = item.frame;
      for (const [id, position] of frameMemberPositions(origin, memberIds)) {
        positions.set(id, position);
      }
      row += frameRows(memberIds.length);
    }
    bottomRow = Math.max(bottomRow, row);
  });

  return {
    bottomRow: bottomRow,
    columns: Math.max(columns.length, 1),
    positions: positions,
  };
}

/** Agents in draw order: roots by label, each followed by its sub-agents. */
function orderAgents(graph: CanvasGraph): LayoutNode[] {
  const childrenOf = new Map<string, LayoutNode[]>();
  const roots: LayoutNode[] = [];
  // Sorted up front, so the root list and every child list come out by label.
  const sorted = [...graph.agents].sort(compareByLabel);

  for (const agent of sorted) {
    const parentId = graph.parentAgentId.get(agent.id);
    if (parentId === undefined || !graph.agentIds.has(parentId)) {
      roots.push(agent);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(agent);
    else childrenOf.set(parentId, [agent]);
  }

  const ordered: LayoutNode[] = [];
  const seen = new Set<string>();
  const visit = (agent: LayoutNode): void => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    ordered.push(agent);
    for (const child of childrenOf.get(agent.id) ?? []) visit(child);
  };

  for (const root of roots) visit(root);
  // Agents inside a sub-agent cycle have no root, so sweep up whatever is left.
  for (const agent of sorted) visit(agent);

  return ordered;
}

/**
 * Grid-step offsets on the square ring `ring` steps out, nearest first: axis
 * neighbours before diagonals, and below or right before above or left, so a
 * displaced card stays close and stays inside the drawn graph.
 */
function ringOffsets(ring: number): LayoutPosition[] {
  if (ring === 0) return [{ x: 0, y: 0 }];

  const offsets: LayoutPosition[] = [];
  for (let x = -ring; x <= ring; x++) {
    offsets.push({ x: x, y: -ring }, { x: x, y: ring });
  }
  for (let y = -ring + 1; y <= ring - 1; y++) {
    offsets.push({ x: -ring, y: y }, { x: ring, y: y });
  }

  return offsets.sort(
    (a, b) =>
      Math.abs(a.x) + Math.abs(a.y) - (Math.abs(b.x) + Math.abs(b.y)) ||
      b.y - a.y ||
      b.x - a.x,
  );
}

function snapToGrid(position: LayoutPosition): LayoutPosition {
  return {
    x: Math.round(position.x / GRID) * GRID,
    y: Math.round(position.y / GRID) * GRID,
  };
}
