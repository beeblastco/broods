/**
 * Deterministic canvas auto-layout, shared by the dashboard, the CLI sync and
 * the account API sync so every writer draws the same picture.
 *
 * Each agent owns a cluster: the agent card sits centred above a block of
 * typed columns holding the services only that agent uses. Sub-agents follow
 * their parent, so the side-handle link between them stays short. Services
 * more than one agent reaches drop to a shared lane under the clusters, and
 * services no agent reaches to an unconnected lane below that.
 */

import type { CanvasNode } from "../canvas";

/** Card box, matching `w-44 min-h-24` on the node shell in `BaseNode.tsx`. */
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 96;

/** Background grid pitch. Every emitted position is a multiple of it. */
export const GRID = 24;

/** Clearance a nudged node keeps from the cards it stepped around. */
const NODE_MARGIN = 16;

const COLUMN_GAP = 40;
const ROW_GAP = 48;
const AGENT_GAP = 120;
const CLUSTER_GAP = 144;
const LANE_GAP = 144;

/** How far {@link findFreePosition} steps out before giving up, in grid cells. */
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
  /** Services no agent reaches — the cards the canvas renders as unconnected. */
  orphanServices: LayoutNode[];
  /** Sub-agent parent, keyed by the child agent's id. */
  parentAgentId: Map<string, string>;
  /** Services more than one agent reaches. */
  sharedServices: LayoutNode[];
};

/** A block of typed columns, and the box it occupies. */
type LayoutBlock = {
  /** Lowest placed card, or 0 when the block is empty. */
  bottom: number;
  positions: Map<string, LayoutPosition>;
  width: number;
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

/** Re-position every node by {@link tidyCanvasLayout}, leaving the rest untouched. */
export function applyTidyLayout<
  T extends LayoutNode & { position: LayoutPosition },
>(nodes: readonly T[], edges: readonly LayoutEdge[]): T[] {
  const positions = tidyCanvasLayout(nodes, edges);

  return nodes.map((node) => {
    const position = positions.get(node.id);

    return position ? { ...node, position: position } : node;
  });
}

/**
 * Nearest grid position to `desired` whose card clears every occupied card.
 * Manual dashboard adds land under the cursor and only move when that exact
 * spot is already taken.
 */
export function findFreePosition(
  desired: LayoutPosition,
  occupied: readonly LayoutPosition[],
): LayoutPosition {
  const start = snapToGrid(desired);
  for (let ring = 0; ring <= MAX_NUDGE_RINGS; ring++) {
    for (const offset of ringOffsets(ring)) {
      const candidate = {
        x: start.x + offset.x * GRID,
        y: start.y + offset.y * GRID,
      };
      if (!occupied.some((taken) => cardsOverlap(candidate, taken))) {
        return candidate;
      }
    }
  }

  return start;
}

/** Lay the whole graph out, returning the new position of every node by id. */
export function tidyCanvasLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, LayoutPosition> {
  const graph = indexGraph(nodes, edges);
  const positions = new Map<string, LayoutPosition>();
  let cursorX = 0;
  let deepestY = NODE_HEIGHT;

  for (const agent of orderAgents(graph)) {
    const services = graph.exclusiveServices.get(agent.id) ?? [];
    const block = layoutBlock(services, cursorX, NODE_HEIGHT + AGENT_GAP);
    positions.set(agent.id, {
      x: cursorX + (block.width - NODE_WIDTH) / 2,
      y: 0,
    });
    for (const [id, position] of block.positions) positions.set(id, position);
    deepestY = Math.max(deepestY, block.bottom);
    cursorX += block.width + CLUSTER_GAP;
  }

  const totalWidth = Math.max(cursorX - CLUSTER_GAP, NODE_WIDTH);
  const lanes = [
    // Centred, because a shared service belongs to no single cluster.
    { centered: true, services: graph.sharedServices },
    // Left-aligned, so unwired cards read as parked rather than part of the graph.
    { centered: false, services: graph.orphanServices },
  ];
  let laneY = deepestY + LANE_GAP;

  for (const lane of lanes) {
    if (lane.services.length === 0) continue;
    const block = layoutBlock(lane.services, 0, laneY);
    const offsetX = lane.centered
      ? Math.max(0, (totalWidth - block.width) / 2)
      : 0;
    for (const [id, position] of block.positions) {
      positions.set(id, { x: position.x + offsetX, y: position.y });
    }
    laneY = block.bottom + LANE_GAP;
  }

  for (const [id, position] of positions) {
    positions.set(id, snapToGrid(position));
  }

  return positions;
}

/** Whether two same-sized cards would touch, margin included. */
function cardsOverlap(a: LayoutPosition, b: LayoutPosition): boolean {
  return (
    Math.abs(a.x - b.x) < NODE_WIDTH + NODE_MARGIN &&
    Math.abs(a.y - b.y) < NODE_HEIGHT + NODE_MARGIN
  );
}

/** Position of a service type in {@link SERVICE_COLUMN_ORDER}; unknown types sort last. */
function columnRank(type: string): number {
  return COLUMN_RANKS.get(type) ?? COLUMN_RANKS.size;
}

/** Compare two nodes by their display label, falling back to id. */
function compareByLabel(a: LayoutNode, b: LayoutNode): number {
  return labelOf(a).localeCompare(labelOf(b));
}

/** Edge kind, from the ReactFlow field when set, else from the persisted id prefix. */
function edgeKind(edge: LayoutEdge): "mount" | "subagent" | "default" {
  if (edge.type === "mount" || edge.id.startsWith("mount:")) return "mount";
  if (edge.type === "subagent" || edge.id.startsWith("subagent:")) {
    return "subagent";
  }

  return "default";
}

/** Group services into typed columns, each column sorted by label. */
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

/**
 * Split the graph into agents, per-agent exclusive services, shared services
 * and orphans, and record the sub-agent hierarchy.
 */
function indexGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): CanvasGraph {
  const agents = nodes.filter((node) => node.type === "agent");
  const services = nodes.filter((node) => node.type !== "agent");
  const agentIds = new Set(agents.map((agent) => agent.id));
  const parentAgentId = new Map<string, string>();
  const ownersByService = new Map<string, Set<string>>();

  for (const edge of edges) {
    const kind = edgeKind(edge);
    if (kind === "mount") continue;
    if (kind === "subagent") {
      if (agentIds.has(edge.source) && agentIds.has(edge.target)) {
        parentAgentId.set(edge.target, edge.source);
      }
      continue;
    }

    // Ownership is read undirected: the dashboard draws agent→service, but a
    // reconnected edge can arrive the other way round.
    const agentId = agentIds.has(edge.source)
      ? edge.source
      : agentIds.has(edge.target)
        ? edge.target
        : null;
    if (!agentId) continue;
    const serviceId = agentId === edge.source ? edge.target : edge.source;
    if (agentIds.has(serviceId)) continue;
    const owners = ownersByService.get(serviceId);
    if (owners) owners.add(agentId);
    else ownersByService.set(serviceId, new Set([agentId]));
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

function labelOf(node: LayoutNode): string {
  return typeof node.data.label === "string" ? node.data.label : node.id;
}

/** Place services as typed columns growing right, rows growing down. */
function layoutBlock(
  services: readonly LayoutNode[],
  originX: number,
  originY: number,
): LayoutBlock {
  const columns = groupIntoColumns(services);
  const positions = new Map<string, LayoutPosition>();
  let bottom = 0;

  columns.forEach((column, columnIndex) => {
    const x = originX + columnIndex * (NODE_WIDTH + COLUMN_GAP);
    column.forEach((node, rowIndex) => {
      const y = originY + rowIndex * (NODE_HEIGHT + ROW_GAP);
      positions.set(node.id, { x: x, y: y });
      bottom = Math.max(bottom, y + NODE_HEIGHT);
    });
  });

  const width =
    columns.length > 0
      ? columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP
      : NODE_WIDTH;

  return { bottom: bottom, positions: positions, width: width };
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

/** Grid offsets on the square ring `ring` cells out. */
function ringOffsets(ring: number): LayoutPosition[] {
  if (ring === 0) return [{ x: 0, y: 0 }];

  const offsets: LayoutPosition[] = [];
  for (let x = -ring; x <= ring; x++) {
    offsets.push({ x: x, y: -ring }, { x: x, y: ring });
  }
  for (let y = -ring + 1; y <= ring - 1; y++) {
    offsets.push({ x: -ring, y: y }, { x: ring, y: y });
  }

  return offsets;
}

function snapToGrid(position: LayoutPosition): LayoutPosition {
  return {
    x: Math.round(position.x / GRID) * GRID,
    y: Math.round(position.y / GRID) * GRID,
  };
}
