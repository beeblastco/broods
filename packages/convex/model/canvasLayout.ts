/**
 * Deterministic canvas auto-layout, shared by the dashboard, the CLI sync and
 * the account API sync so every writer draws the same picture.
 *
 * The tidy layout reads like an org chart: agents along the top, each over a
 * row of the services it reaches, so most edges are one drop, one run along
 * the agent's bus and one drop into the service. Drags and manual adds are
 * finer: they snap to the background dot grid and only step aside when they
 * would cover another card.
 *
 * Each agent owns a cluster: the agent card sits over the middle of a block of
 * columns holding the services only that agent uses. Every sandbox, workspace
 * and MCP group (a frame, or a card when it has one member) takes its own
 * column; sessions and skills stack in one column each. Sub-agents follow
 * their parent, so the side-handle link between them stays short. Services
 * several agents reach sit in a block right after the first of those agents'
 * clusters, so it lands between them; services no agent reaches park in a lane
 * below. A mount edge ties its two cards together: an agent that reaches one
 * reaches the other, so a mounted pair always lands in the same block. Groups
 * come from `canvasFrames.ts`, so the dashboard reads back the same frames the
 * layout packed.
 *
 * Columns are as wide as their widest box plus a gutter, and the gap under
 * the agent row and each gutter grow, in grid steps, until the lanes routed
 * through them fit. The lanes come from `canvasEdgeRoutes.ts`, the same
 * router the dashboard draws with.
 */

import type { CanvasNode } from "../canvas";
import {
  BUS_INSET,
  facingSide,
  handlePoint,
  LANE_SPACING,
  routeCanvasEdges,
  type AgentEdgeRequest,
  type SideEdgeRequest,
} from "./canvasEdgeRoutes";
import {
  agentOwners,
  compareByLabel,
  deriveCanvasGroups,
  edgeKind,
  FRAME_CHIP_HEIGHTS,
  FRAME_CHIP_WIDTH,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  FRAME_WIDTH,
  inheritedSandboxIds,
  type CanvasFrame,
  type McpTransportsByNode,
} from "./canvasFrames";

/** Card box, matching `w-44 min-h-24` on the node shell in `BaseNode.tsx`. */
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 96;

/** Background dot pitch. Drags snap to it, and cell sizes are multiples of it. */
export const GRID = 24;

/** Gap under a stacked box, and under the agent row before its bus needs more. */
const STACK_GAP = 48;

/** Top of the service row: an agent card, then the gap its bus runs in. */
export const SERVICE_TOP = NODE_HEIGHT + STACK_GAP;

/**
 * Column index to x before columns get their real widths: every box starts at
 * `column * COLUMN_UNIT`, plus a chip's inset in its frame.
 */
const COLUMN_UNIT = 1000;

/** Gutter between two columns before its lanes need more. */
const MIN_GUTTER = 40;

/** Clearance a nudged card keeps from the cards it stepped around. */
const NODE_MARGIN = 16;

/** How far {@link findFreePosition} steps out before giving up, in dot-grid steps. */
const MAX_NUDGE_RINGS = 48;

/** Widen-and-reroute rounds before the tidy layout settles for what it has. */
const MAX_LANE_PASSES = 4;

/**
 * Column order for an agent's services. Every edge that runs between two
 * columns has them side by side, so it crosses one gutter and no frame: MCP
 * sits left of sandbox for the runs-on edge, workspace right of sandbox for
 * the mount edge. Exhaustive over the node types on purpose: adding one to
 * `canvasNodeValidator` without giving it a column is a compile error here.
 */
const SERVICE_COLUMN_ORDER: Record<
  Exclude<CanvasNode["type"], "agent">,
  number
> = {
  database: 0,
  mcp: 1,
  sandbox: 2,
  workspace: 3,
  skill: 4,
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
  /** Services more than one agent reaches, with the agents that reach them. */
  sharedServices: { node: LayoutNode; owners: ReadonlySet<string> }[];
};

/** One box a column holds: a group (a frame, or a card with one member) or an ungrouped card. */
type ColumnItem = { group: CanvasFrame } | { node: LayoutNode };

/**
 * Column widths, and pixels added on top of the minimum spacing: under the
 * agent row, and per gutter (keyed by the column right of it).
 */
type LaneRoom = {
  bus: number;
  gutters: Map<number, number>;
  widths: ReadonlyMap<number, number>;
};

/** A block of columns, and how far down it reaches. */
type LayoutBlock = {
  /** Below the lowest placed box and its gap, or the origin when empty. */
  bottomY: number;
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
  const groups = deriveCanvasGroups(nodes, edges, mcpTransports);
  const frames = framesOf(groups);
  const cells = cellLayout(nodes, edges, groups);
  let room: LaneRoom = {
    bus: 0,
    gutters: new Map(),
    widths: columnWidths(cells, frames),
  };
  for (let pass = 0; pass < MAX_LANE_PASSES; pass++) {
    const positions = spreadCells(cells, room);
    const needed = laneRoom(nodes, edges, frames, positions, room);
    if (
      needed.bus === room.bus &&
      [...needed.gutters].every(([b, px]) => room.gutters.get(b) === px)
    ) {
      return positions;
    }
    room = needed;
  }

  return spreadCells(cells, room);
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

/**
 * Nodes in cell space: agents on top, each over its block of services at
 * SERVICE_TOP, a block of shared services right after the first agent that
 * reaches them, unwired ones parked below. x is a column index times
 * COLUMN_UNIT (plus a chip's inset); y is already in pixels.
 */
function cellLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  groups: readonly CanvasFrame[],
): Map<string, LayoutPosition> {
  const graph = indexGraph(nodes, edges);
  const agents = orderAgents(graph);
  const rank = new Map(agents.map((agent, index) => [agent.id, index]));
  const sharedAfter = new Map<string, LayoutNode[]>();
  for (const { node, owners } of graph.sharedServices) {
    const [anchor] = [...owners].sort(
      (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
    );
    sharedAfter.set(anchor, [...(sharedAfter.get(anchor) ?? []), node]);
  }
  const positions = new Map<string, LayoutPosition>();
  let cursorColumn = 0;
  let deepestY = SERVICE_TOP;
  const place = (block: LayoutBlock): void => {
    for (const [id, position] of block.positions) positions.set(id, position);
    deepestY = Math.max(deepestY, block.bottomY);
    cursorColumn += block.columns;
  };

  for (const agent of agents) {
    const services = graph.exclusiveServices.get(agent.id) ?? [];
    const block = layoutBlock(services, groups, cursorColumn, SERVICE_TOP);
    // Middle column of the block; the left one of the two when the count is even.
    const column = cursorColumn + Math.floor((block.columns - 1) / 2);
    positions.set(agent.id, { x: column * COLUMN_UNIT, y: 0 });
    place(block);
    const shared = sharedAfter.get(agent.id);
    if (shared) place(layoutBlock(shared, groups, cursorColumn, SERVICE_TOP));
  }
  if (graph.orphanServices.length > 0) {
    // Left-aligned, so unwired cards read as parked rather than part of the graph.
    const parked = layoutBlock(
      graph.orphanServices,
      groups,
      0,
      deepestY + STACK_GAP,
    );
    for (const [id, position] of parked.positions) positions.set(id, position);
  }

  return positions;
}

/**
 * A typed column's groups in group order, then its ungrouped cards by label.
 * Among sandbox groups the computers come first and among MCP groups last,
 * so a machine server sits beside the computer its runs-on edge reaches and
 * a cloud sandbox beside the workspaces mounted on it.
 */
function columnItems(
  column: readonly LayoutNode[],
  groups: readonly CanvasFrame[],
): ColumnItem[] {
  const ids = new Set(column.map((node) => node.id));
  const grouped = groups
    .filter((group) => group.memberIds.some((id) => ids.has(id)))
    .sort((a, b) => machineRank(a) - machineRank(b));
  const groupedIds = new Set(grouped.flatMap((group) => group.memberIds));

  return [
    ...grouped.map((group) => ({ group: group })),
    ...column
      .filter((node) => !groupedIds.has(node.id))
      .map((node) => ({ node: node })),
  ];
}

/** Left edge of a column: every column before it, its gutter and that gutter's room, on the grid. */
function columnLeft(column: number, room: LaneRoom): number {
  let left = 0;
  for (let index = 0; index < column; index++) {
    left = roundUpToGrid(
      left +
        widthOf(index, room) +
        MIN_GUTTER +
        (room.gutters.get(index + 1) ?? 0),
    );
  }

  return left;
}

/** Position of a service type in {@link SERVICE_COLUMN_ORDER}; unknown types sort last. */
function columnRank(type: string): number {
  return COLUMN_RANKS.get(type) ?? COLUMN_RANKS.size;
}

/** Each column's width: a frame's where it holds one, else a card's. */
function columnWidths(
  cells: ReadonlyMap<string, LayoutPosition>,
  frames: readonly CanvasFrame[],
): Map<number, number> {
  const framed = new Set(frames.flatMap((frame) => frame.memberIds));
  const widths = new Map<number, number>();
  for (const [id, position] of cells) {
    const column = Math.floor(position.x / COLUMN_UNIT);
    const width = framed.has(id) ? FRAME_WIDTH : NODE_WIDTH;
    widths.set(column, Math.max(widths.get(column) ?? 0, width));
  }

  return widths;
}

/**
 * The edges the dashboard draws at `positions`, for the router: one agent
 * edge per agent and frame or card, and a side edge per mount and inherited
 * sandbox. Also the top-level boxes they run between and around.
 */
function edgeRequests(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  frames: readonly CanvasFrame[],
  positions: ReadonlyMap<string, LayoutPosition>,
): {
  agentEdges: AgentEdgeRequest[];
  boxes: Map<string, LayoutRect>;
  sideEdges: SideEdgeRequest[];
} {
  const frameOf = new Map<string, CanvasFrame>();
  for (const frame of frames) {
    for (const id of frame.memberIds) frameOf.set(id, frame);
  }
  const agentIds = new Set(
    nodes.filter((node) => node.type === "agent").map((node) => node.id),
  );
  const boxes = new Map<string, LayoutRect>();
  for (const frame of frames) {
    const origin = frameOriginOf(
      frame.memberIds.flatMap((id) => positions.get(id) ?? []),
    );
    boxes.set(frame.id, { ...origin, ...frameSize(frame) });
  }
  for (const [id, position] of positions) {
    if (frameOf.has(id)) continue;
    boxes.set(id, { ...position, height: NODE_HEIGHT, width: NODE_WIDTH });
  }

  const agentEdges = new Map<string, AgentEdgeRequest>();
  const sidePairs: [string, string][] = [...inheritedSandboxIds(nodes, edges)];
  for (const edge of edges) {
    const kind = edgeKind(edge);
    // The dashboard draws agent→service, but an edge can arrive reversed.
    const [agentId, serviceId] = agentIds.has(edge.source)
      ? [edge.source, edge.target]
      : [edge.target, edge.source];
    const fromAgent = agentIds.has(agentId) && !agentIds.has(serviceId);
    if (kind === "mount" && !agentIds.has(agentId)) {
      sidePairs.push([edge.source, edge.target]);
    }
    if (kind !== "default" || !fromAgent) continue;
    const target = frameOf.get(serviceId)?.id ?? serviceId;
    const id = `${agentId}>${target}`;
    agentEdges.set(id, { id: id, source: agentId, target: target });
  }
  const handleBox = (id: string): LayoutRect | undefined => {
    const frame = frameOf.get(id);
    const position = positions.get(id);

    return frame && position
      ? {
          ...position,
          height: FRAME_CHIP_HEIGHTS[frame.kind],
          width: FRAME_CHIP_WIDTH,
        }
      : boxes.get(id);
  };
  const sideEdges = sidePairs.flatMap(([a, b]): SideEdgeRequest[] => {
    const boxA = handleBox(a);
    const boxB = handleBox(b);
    if (!boxA || !boxB) return [];

    return [
      {
        id: `${a}|${b}`,
        source: handlePoint(boxA, facingSide(boxA, boxB)),
        target: handlePoint(boxB, facingSide(boxB, boxA)),
      },
    ];
  });

  return {
    agentEdges: [...agentEdges.values()],
    boxes: boxes,
    sideEdges: sideEdges,
  };
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
  const sharedServices: CanvasGraph["sharedServices"] = [];

  for (const service of services) {
    const owners = ownersByService.get(service.id);
    if (!owners) {
      orphanServices.push(service);
      continue;
    }
    if (owners.size > 1) {
      sharedServices.push({ node: service, owners: owners });
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
 * `room` grown wherever the lanes routed at `positions` do not fit: the bus
 * gap under the agent row, or a column gutter (keyed by the column on its
 * right).
 */
function laneRoom(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  frames: readonly CanvasFrame[],
  positions: ReadonlyMap<string, LayoutPosition>,
  room: LaneRoom,
): LaneRoom {
  const { agentEdges, boxes, sideEdges } = edgeRequests(
    nodes,
    edges,
    frames,
    positions,
  );
  const routes = routeCanvasEdges(boxes, agentEdges, sideEdges);

  const busDepth = Math.max(
    0,
    ...[...routes.agent.values()].map((route) => route.busDrop + BUS_INSET),
  );
  const busGap = STACK_GAP + room.bus;
  const lanesByGutter = new Map<number, number[]>();
  const addLane = (x: number, ends: readonly number[]): void => {
    // The gutter right of a column's centre and left of the next one's.
    let boundary = 0;
    while (x > columnLeft(boundary, room) + widthOf(boundary, room) / 2) {
      boundary++;
    }
    // A side edge between columns that are not neighbours has no one gutter.
    const reach = columnLeft(boundary, room) + widthOf(boundary, room);
    if (
      boundary === 0 ||
      ends.some((end) => end < columnLeft(boundary - 1, room) || end > reach)
    ) {
      return;
    }
    const lanes = lanesByGutter.get(boundary);
    if (lanes) lanes.push(x);
    else lanesByGutter.set(boundary, [x]);
  };
  for (const route of routes.agent.values()) {
    if (route.gutter) addLane(route.gutter.x, []);
  }
  for (const edge of sideEdges) {
    const route = routes.side.get(edge.id);
    if (route) addLane(route.centerX, [edge.source.x, edge.target.x]);
  }
  const gutters = new Map(room.gutters);
  for (const [boundary, lanes] of lanesByGutter) {
    const current = room.gutters.get(boundary) ?? 0;
    const needed = Math.max(...lanes) - Math.min(...lanes) + LANE_SPACING * 2;
    const width =
      columnLeft(boundary, room) -
      columnLeft(boundary - 1, room) -
      widthOf(boundary - 1, room);
    if (needed > width) {
      gutters.set(boundary, current + roundUpToGrid(needed - width));
    }
  }

  return {
    bus: room.bus + roundUpToGrid(Math.max(0, busDepth - busGap)),
    gutters: gutters,
    widths: room.widths,
  };
}

/**
 * Place services as columns growing right from `originColumn`, each column
 * stacking down from `originY` with a STACK_GAP under every box. A sandbox,
 * workspace or MCP group takes a column of its own; any other type shares one.
 * An empty block still claims one column for its agent.
 */
function layoutBlock(
  services: readonly LayoutNode[],
  groups: readonly CanvasFrame[],
  originColumn: number,
  originY: number,
): LayoutBlock {
  const columns = groupIntoColumns(services).flatMap((column) => {
    const items = columnItems(column, groups);

    return items.every((item) => "group" in item)
      ? items.map((item) => [item])
      : [items];
  });
  const positions = new Map<string, LayoutPosition>();
  let bottomY = originY;

  columns.forEach((items, columnIndex) => {
    let y = originY;
    for (const item of items) {
      const origin = { x: (originColumn + columnIndex) * COLUMN_UNIT, y: y };
      if ("node" in item || item.group.memberIds.length === 1) {
        const id = "node" in item ? item.node.id : item.group.memberIds[0];
        positions.set(id, origin);
        y = roundUpToGrid(y + NODE_HEIGHT + STACK_GAP);
        continue;
      }
      for (const [id, position] of frameMemberPositions(origin, item.group)) {
        positions.set(id, position);
      }
      y = roundUpToGrid(y + frameSize(item.group).height + STACK_GAP);
    }
    bottomY = Math.max(bottomY, y);
  });

  return {
    bottomY: bottomY,
    columns: Math.max(columns.length, 1),
    positions: positions,
  };
}

/** Where a group sorts among its kind: computers first for sandboxes, last for MCP servers. */
function machineRank(group: CanvasFrame): number {
  if (group.key !== "machine") return 0;

  return group.kind === "sandbox" ? -1 : 1;
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

function roundUpToGrid(value: number): number {
  return Math.ceil(value / GRID) * GRID;
}

function snapToGrid(position: LayoutPosition): LayoutPosition {
  return {
    x: Math.round(position.x / GRID) * GRID,
    y: Math.round(position.y / GRID) * GRID,
  };
}

/** Cell positions at their columns' real left edges, and below the agent row pushed down by the bus room. */
function spreadCells(
  cells: ReadonlyMap<string, LayoutPosition>,
  room: LaneRoom,
): Map<string, LayoutPosition> {
  return new Map(
    [...cells].map(([id, position]): [string, LayoutPosition] => {
      const column = Math.floor(position.x / COLUMN_UNIT);

      return [
        id,
        {
          x: position.x - column * COLUMN_UNIT + columnLeft(column, room),
          y: position.y >= SERVICE_TOP ? position.y + room.bus : position.y,
        },
      ];
    }),
  );
}

function widthOf(column: number, room: LaneRoom): number {
  return room.widths.get(column) ?? NODE_WIDTH;
}
