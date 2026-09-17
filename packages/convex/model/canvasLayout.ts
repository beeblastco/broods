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
 * rows as its expanded height needs. A group of one stays a card on its cell.
 * Groups come from `canvasFrames.ts`, so the dashboard reads back the same
 * frames the layout packed.
 *
 * Cells are then pulled apart where edges need room: the gap under the agent
 * row grows until every bus lane fits, and a column gutter grows until its
 * lanes fit, both in whole grid steps. The lanes come from
 * `canvasEdgeRoutes.ts`, the same router the dashboard draws with.
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

/**
 * One tidy-layout cell: a frame (the widest box) plus the gutter to the next
 * column. An agent's edge into a stacked frame runs down that gutter, so it
 * has to stay clear of both columns.
 */
export const CELL_WIDTH = FRAME_WIDTH + 40;
export const CELL_HEIGHT = NODE_HEIGHT + 48;

/** Empty cells between two agent clusters, and above each lane. */
const CLUSTER_GAP_COLUMNS = 1;
const LANE_GAP_ROWS = 1;

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
  /** Services more than one agent reaches. */
  sharedServices: LayoutNode[];
};

/** One item a column stacks: a frame and its members, or a lone card. */
type ColumnItem = { frame: CanvasFrame } | { node: LayoutNode };

/** Pixels added between cells: under the agent row, and per column gutter (keyed by the column right of it). */
type LaneRoom = { bus: number; gutters: Map<number, number> };

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
  const groups = deriveCanvasGroups(nodes, edges, mcpTransports);
  const cells = cellLayout(nodes, edges, groups);
  let room: LaneRoom = { bus: 0, gutters: new Map() };
  for (let pass = 0; pass < MAX_LANE_PASSES; pass++) {
    const positions = spreadCells(cells, room);
    const needed = laneRoom(nodes, edges, framesOf(groups), positions, room);
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
 * Nodes on whole cells: agent clusters along the top, shared services in a
 * lane below them, unwired ones below that. Positions are in cell units times
 * the cell size, before any gutter or bus room is added.
 */
function cellLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  groups: readonly CanvasFrame[],
): Map<string, LayoutPosition> {
  const graph = indexGraph(nodes, edges);
  const positions = new Map<string, LayoutPosition>();
  let cursorColumn = 0;
  let deepestRow = 1;

  for (const agent of orderAgents(graph)) {
    const services = graph.exclusiveServices.get(agent.id) ?? [];
    const block = layoutBlock(services, groups, cursorColumn, 1);
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
    const block = layoutBlock(lane.services, groups, 0, laneRow);
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

/** Top-left corner of a cell. */
function cellPosition(column: number, row: number): LayoutPosition {
  return { x: column * CELL_WIDTH, y: row * CELL_HEIGHT };
}

/**
 * A column's groups in group order, each a frame or, with one member, a card;
 * then its ungrouped cards by label.
 */
function columnItems(
  column: readonly LayoutNode[],
  groups: readonly CanvasFrame[],
): ColumnItem[] {
  const byId = new Map(column.map((node) => [node.id, node]));
  const grouped = groups.filter((group) =>
    group.memberIds.some((id) => byId.has(id)),
  );
  const groupedIds = new Set(grouped.flatMap((group) => group.memberIds));

  return [
    ...grouped.flatMap((group): ColumnItem[] => {
      if (group.memberIds.length > 1) return [{ frame: group }];
      const node = byId.get(group.memberIds[0]);

      return node ? [{ node: node }] : [];
    }),
    ...column
      .filter((node) => !groupedIds.has(node.id))
      .map((node) => ({ node: node })),
  ];
}

/** Left edge of a column once the gutters before it have their room. */
function columnLeft(column: number, room: LaneRoom): number {
  let left = column * CELL_WIDTH;
  for (const [boundary, extra] of room.gutters) {
    if (boundary <= column) left += extra;
  }

  return left;
}

/** Position of a service type in {@link SERVICE_COLUMN_ORDER}; unknown types sort last. */
function columnRank(type: string): number {
  return COLUMN_RANKS.get(type) ?? COLUMN_RANKS.size;
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

/** Whole cells a frame claims: its expanded height plus the usual gap, rounded up. */
function frameRows(frame: CanvasFrame): number {
  const gap = CELL_HEIGHT - NODE_HEIGHT;

  return Math.ceil((frameSize(frame).height + gap) / CELL_HEIGHT);
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
  const busGap = CELL_HEIGHT - NODE_HEIGHT + room.bus;
  const lanesByGutter = new Map<number, number[]>();
  const addLane = (x: number, ends: readonly number[]): void => {
    // The gutter right of a column's centre and left of the next one's.
    let boundary = 0;
    while (x > columnLeft(boundary, room) + FRAME_WIDTH / 2) boundary++;
    // A side edge between columns that are not neighbours has no one gutter.
    const reach = columnLeft(boundary, room) + FRAME_WIDTH;
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
    const width = CELL_WIDTH - FRAME_WIDTH + current;
    if (needed > width) {
      gutters.set(boundary, current + roundUpToGrid(needed - width));
    }
  }

  return {
    bus: room.bus + roundUpToGrid(Math.max(0, busDepth - busGap)),
    gutters: gutters,
  };
}

/**
 * Place services as typed columns growing right, rows growing down, starting
 * at the given cell. An empty block still claims one column for its agent.
 */
function layoutBlock(
  services: readonly LayoutNode[],
  groups: readonly CanvasFrame[],
  originColumn: number,
  originRow: number,
): LayoutBlock {
  const columns = groupIntoColumns(services);
  const positions = new Map<string, LayoutPosition>();
  let bottomRow = originRow;

  columns.forEach((column, columnIndex) => {
    let row = originRow;
    for (const item of columnItems(column, groups)) {
      const origin = cellPosition(originColumn + columnIndex, row);
      if ("node" in item) {
        positions.set(item.node.id, origin);
        row += 1;
        continue;
      }
      for (const [id, position] of frameMemberPositions(origin, item.frame)) {
        positions.set(id, position);
      }
      row += frameRows(item.frame);
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

function roundUpToGrid(value: number): number {
  return Math.ceil(value / GRID) * GRID;
}

function snapToGrid(position: LayoutPosition): LayoutPosition {
  return {
    x: Math.round(position.x / GRID) * GRID,
    y: Math.round(position.y / GRID) * GRID,
  };
}

/** Cell positions moved right by the gutter room before their column, and down by the bus room below the agent row. */
function spreadCells(
  cells: ReadonlyMap<string, LayoutPosition>,
  room: LaneRoom,
): Map<string, LayoutPosition> {
  return new Map(
    [...cells].map(([id, position]): [string, LayoutPosition] => {
      const column = Math.floor(position.x / CELL_WIDTH);

      return [
        id,
        {
          x: position.x + columnLeft(column, room) - column * CELL_WIDTH,
          y: position.y >= CELL_HEIGHT ? position.y + room.bus : position.y,
        },
      ];
    }),
  );
}
