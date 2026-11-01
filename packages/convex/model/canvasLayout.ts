// Deterministic: the dashboard, the CLI sync and the account API sync all lay out with it,
// so every writer draws the same picture.

import type { CanvasNode } from "./canvasShapes";
import {
  ARROW_RUN,
  BUS_INSET,
  facingSide,
  LANE_SPACING,
  routeCanvasEdges,
  type AgentEdgeRequest,
  type EdgeRoutes,
  type SideEdgeRequest,
} from "./canvasEdgeRoutes";
import {
  agentOwners,
  compareByLabel,
  deriveCanvasGroups,
  edgeKind,
  FRAME_CHIP_HEIGHT,
  FRAME_CHIP_WIDTH,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  FRAME_WIDTH,
  runsOnSandboxIds,
  workspaceSandboxIds,
  type CanvasFrame,
  type McpServersByNode,
  type WorkspaceSandboxIds,
} from "./canvasFrames";

// Matches `w-44 min-h-24` on the node shell in `BaseNode.tsx`.
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 96;

export const GRID = 24;

const STACK_GAP = 48;

export const SERVICE_TOP = NODE_HEIGHT + STACK_GAP;

// Status row with its globe badge, measured from `BaseNode.tsx` at scale 1.
export const CARD_STATUS_ROW = 38;

// Cell space x is `column * COLUMN_UNIT` (plus a chip's inset) until columns get real widths.
const COLUMN_UNIT = 1000;

const MIN_GUTTER = 40;

const NODE_MARGIN = 16;

const MAX_NUDGE_RINGS = 48;

// Room only grows, so the passes settle; the cap only guards against a bug looping forever.
const MAX_LANE_PASSES = 32;

// Exhaustive: a node type added to `canvasNodeValidator` without a column fails to compile.
const SERVICE_COLUMN_ORDER: Record<
  Exclude<CanvasNode["type"], "agent">,
  number
> = {
  mcp: 0,
  sandbox: 1,
  workspace: 2,
  skill: 3,
};

const COLUMN_RANKS: ReadonlyMap<string, number> = new Map(
  Object.entries(SERVICE_COLUMN_ORDER),
);

const COLUMN_LEFTS = new WeakMap<LaneRoom, number[]>();

type CanvasGraph = {
  agentIds: Set<string>;
  agents: LayoutNode[];
  exclusiveServices: Map<string, LayoutNode[]>;
  orphanServices: LayoutNode[];
  parentAgentId: Map<string, string>;
  sharedServices: { node: LayoutNode; owners: ReadonlySet<string> }[];
};

type Cells = {
  parked: ReadonlySet<string>;
  positions: Map<string, LayoutPosition>;
  serviceTop: number;
  stackIndex: Map<string, number>;
};

type ColumnItem = { group: CanvasFrame } | { node: LayoutNode };

// Px added over the minimum spacing; `gutters` is keyed by the column right of each gutter.
type LaneRoom = {
  bus: number;
  gutters: Map<number, number>;
  stack: number;
  under: number;
  widths: ReadonlyMap<number, number>;
};

type LayoutContext = {
  groupOf: ReadonlyMap<string, CanvasFrame>;
  groupRanks: ReadonlyMap<CanvasFrame, number>;
  sidePairs: readonly (readonly [string, string, string])[];
  types: ReadonlyMap<string, string | undefined>;
};

type BlockPlace = { rank: number; ranks: ReadonlyMap<string, number> };

type LayoutBlock = {
  bottomY: number;
  columns: number;
  positions: Map<string, LayoutPosition>;
  stackIndex: Map<string, number>;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  /** Set on dashboard edges; the persisted form carries the kind in `id`. */
  type?: string | undefined;
};

export type LayoutNode = {
  id: string;
  type?: string | undefined;
  data: Record<string, unknown>;
};

export type LayoutPosition = CanvasNode["position"];

export type LayoutRect = LayoutPosition & {
  height: number;
  width: number;
};

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
  mcpServers: McpServersByNode,
): T[] {
  return applyPositions(nodes, tidyCanvasLayout(nodes, edges, mcpServers));
}

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
  mcpServers: McpServersByNode,
): Map<string, LayoutPosition> {
  const groups = deriveCanvasGroups(nodes, edges, mcpServers);
  const frames = framesOf(groups);
  const states = workspaceSandboxIds(nodes, edges);
  const context: LayoutContext = {
    groupOf: new Map(
      groups.flatMap((group) =>
        group.memberIds.map((id): [string, CanvasFrame] => [id, group]),
      ),
    ),
    groupRanks: new Map(groups.map((group, index) => [group, index])),
    sidePairs: sidePairs(nodes, edges, mcpServers, states),
    types: new Map(nodes.map((node) => [node.id, node.type])),
  };
  const cells = cellLayout(nodes, edges, context);
  let room: LaneRoom = {
    bus: 0,
    gutters: new Map(),
    stack: 0,
    under: 0,
    widths: columnWidths(cells.positions, frames),
  };
  let positions = spreadCells(cells, room);
  for (let pass = 0; pass < MAX_LANE_PASSES; pass++) {
    const needed = laneRoom(context, edges, frames, cells, positions, room);
    if (sameRoom(needed, room)) break;
    room = needed;
    positions = spreadCells(cells, room);
  }

  return positions;
}

export function workspaceStateText(
  kind: "inherited" | "override" | "readonly",
  sandboxLabels: readonly string[],
): string {
  if (kind === "readonly") return "read-only";
  const sandboxes =
    sandboxLabels.length === 1
      ? sandboxLabels[0]
      : `${sandboxLabels.length} sandboxes`;

  return `${sandboxes} · ${kind === "override" ? "mounted" : "inherited"}`;
}

function busShortfall(
  agentEdges: readonly AgentEdgeRequest[],
  boxes: ReadonlyMap<string, LayoutRect>,
  routes: EdgeRoutes,
  cells: Cells,
  room: LaneRoom,
): number {
  const rowTop = cells.serviceTop + room.bus;

  return Math.max(
    0,
    ...agentEdges.flatMap((edge) => {
      const agent = boxes.get(edge.source);
      const route = routes.agent.get(edge.id);
      if (!agent || !route) return [];

      return [agent.y + agent.height + route.busDrop + BUS_INSET - rowTop];
    }),
  );
}

function cardOverlaps(card: LayoutPosition, box: LayoutRect): boolean {
  return (
    card.x < box.x + box.width + NODE_MARGIN &&
    box.x < card.x + NODE_WIDTH + NODE_MARGIN &&
    card.y < box.y + box.height + NODE_MARGIN &&
    box.y < card.y + NODE_HEIGHT + NODE_MARGIN
  );
}

function cellLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  context: LayoutContext,
): Cells {
  const graph = indexGraph(nodes, edges);
  const agents = orderAgents(graph);
  const rank = new Map(agents.map((agent, index) => [agent.id, index]));
  // A shared service joins the middle agent's block, so its edges stay short both ways.
  const blockRanks = new Map<string, number>();
  const servicesOf = new Map<string, LayoutNode[]>();
  const assign = (agentId: string, node: LayoutNode): void => {
    blockRanks.set(node.id, rank.get(agentId) ?? 0);
    const services = servicesOf.get(agentId);
    if (services) services.push(node);
    else servicesOf.set(agentId, [node]);
  };
  for (const [agentId, services] of graph.exclusiveServices) {
    for (const node of services) assign(agentId, node);
  }
  for (const { node, owners } of graph.sharedServices) {
    const ranked = [...owners].sort(
      (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
    );
    assign(ranked[Math.floor((ranked.length - 1) / 2)], node);
  }
  const serviceTop = roundUpToGrid(
    Math.max(NODE_HEIGHT, ...agents.map((): number => NODE_HEIGHT)) + STACK_GAP,
  );
  const positions = new Map<string, LayoutPosition>();
  const stackIndex = new Map<string, number>();
  let cursorColumn = 0;
  let deepestY = serviceTop;
  const place = (block: LayoutBlock): void => {
    for (const [id, position] of block.positions) positions.set(id, position);
    for (const [id, index] of block.stackIndex) stackIndex.set(id, index);
    deepestY = Math.max(deepestY, block.bottomY);
  };

  for (const agent of agents) {
    const block = layoutBlock(
      servicesOf.get(agent.id) ?? [],
      context,
      { ranks: blockRanks, rank: rank.get(agent.id) ?? 0 },
      cursorColumn,
      serviceTop,
    );
    const column = cursorColumn + Math.floor((block.columns - 1) / 2);
    positions.set(agent.id, { x: column * COLUMN_UNIT, y: 0 });
    place(block);
    cursorColumn += block.columns;
  }
  const parked = layoutBlock(
    graph.orphanServices,
    context,
    null,
    0,
    deepestY + STACK_GAP,
  );
  place(parked);

  return {
    parked: new Set(parked.positions.keys()),
    positions: positions,
    serviceTop: serviceTop,
    stackIndex: stackIndex,
  };
}

function columnItems(
  column: readonly LayoutNode[],
  context: LayoutContext,
): ColumnItem[] {
  const grouped = new Set<CanvasFrame>();
  const loose: LayoutNode[] = [];
  for (const node of column) {
    const group = context.groupOf.get(node.id);
    if (group) grouped.add(group);
    else loose.push(node);
  }

  return [
    ...[...grouped]
      .sort(
        (a, b) =>
          (context.groupRanks.get(a) ?? 0) - (context.groupRanks.get(b) ?? 0),
      )
      .map((group) => ({ group: group })),
    ...loose.map((node) => ({ node: node })),
  ];
}

function columnLeft(column: number, room: LaneRoom): number {
  let lefts = COLUMN_LEFTS.get(room);
  if (!lefts) {
    lefts = [0];
    COLUMN_LEFTS.set(room, lefts);
  }
  for (let index = lefts.length; index <= column; index++) {
    lefts.push(
      roundUpToGrid(
        lefts[index - 1] +
          widthOf(index - 1, room) +
          MIN_GUTTER +
          (room.gutters.get(index) ?? 0),
      ),
    );
  }

  return lefts[column];
}

function columnRank(type: string): number {
  return COLUMN_RANKS.get(type) ?? COLUMN_RANKS.size;
}

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

function edgeRequests(
  context: LayoutContext,
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
  const boxes = new Map<string, LayoutRect>();
  for (const frame of frames) {
    const origin = frameOriginOf(
      frame.memberIds.flatMap((id) => positions.get(id) ?? []),
    );
    boxes.set(frame.id, { ...origin, ...frameSize(frame) });
  }
  for (const [id, position] of positions) {
    if (frameOf.has(id)) continue;
    boxes.set(id, {
      ...position,
      height: NODE_HEIGHT,
      width: NODE_WIDTH,
    });
  }

  const isAgent = (id: string): boolean => context.types.get(id) === "agent";
  const agentEdges = new Map<string, AgentEdgeRequest>();
  for (const edge of edges) {
    const [agentId, serviceId] = isAgent(edge.source)
      ? [edge.source, edge.target]
      : [edge.target, edge.source];
    if (
      edgeKind(edge) !== "default" ||
      !isAgent(agentId) ||
      isAgent(serviceId)
    ) {
      continue;
    }
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
          height: FRAME_CHIP_HEIGHT,
          width: FRAME_CHIP_WIDTH,
        }
      : boxes.get(id);
  };
  const sideEdges = context.sidePairs.flatMap(
    ([a, b, kind]): SideEdgeRequest[] => {
      const boxA = handleBox(a);
      const boxB = handleBox(b);
      if (!boxA || !boxB) return [];

      return [
        {
          id: `${a}|${b}`,
          kind: kind,
          source: {
            box: boxA,
            nodeId: a,
            outerId: frameOf.get(a)?.id ?? a,
            side: facingSide(boxA, boxB),
          },
          target: {
            box: boxB,
            nodeId: b,
            outerId: frameOf.get(b)?.id ?? b,
            side: facingSide(boxB, boxA),
          },
        },
      ];
    },
  );

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

function laneRoom(
  context: LayoutContext,
  edges: readonly LayoutEdge[],
  frames: readonly CanvasFrame[],
  cells: Cells,
  positions: ReadonlyMap<string, LayoutPosition>,
  room: LaneRoom,
): LaneRoom {
  const { agentEdges, boxes, sideEdges } = edgeRequests(
    context,
    edges,
    frames,
    positions,
  );
  const routes = routeCanvasEdges(boxes, agentEdges, sideEdges);

  return {
    bus:
      room.bus +
      roundUpToGrid(busShortfall(agentEdges, boxes, routes, cells, room)),
    gutters: gutterRoom(routes, room),
    stack:
      room.stack + roundUpToGrid(stackShortfall(agentEdges, boxes, routes)),
    under:
      room.under + roundUpToGrid(underShortfall(routes, boxes, cells.parked)),
    widths: room.widths,
  };
}

function layoutBlock(
  services: readonly LayoutNode[],
  context: LayoutContext,
  place: BlockPlace | null,
  originColumn: number,
  originY: number,
): LayoutBlock {
  const columns = orderColumns(
    groupIntoColumns(services).map((column) => columnItems(column, context)),
    context,
    place,
  );
  const positions = new Map<string, LayoutPosition>();
  const stackIndex = new Map<string, number>();
  let bottomY = originY;

  columns.forEach((items, columnIndex) => {
    let y = originY;
    items.forEach((item, index) => {
      const origin = { x: (originColumn + columnIndex) * COLUMN_UNIT, y: y };
      if ("node" in item || item.group.memberIds.length === 1) {
        const id = "node" in item ? item.node.id : item.group.memberIds[0];
        positions.set(id, origin);
        stackIndex.set(id, index);
        y = roundUpToGrid(y + NODE_HEIGHT + STACK_GAP);

        return;
      }
      for (const [id, position] of frameMemberPositions(origin, item.group)) {
        positions.set(id, position);
        stackIndex.set(id, index);
      }
      y = roundUpToGrid(y + frameSize(item.group).height + STACK_GAP);
    });
    bottomY = Math.max(bottomY, y);
  });

  return {
    bottomY: bottomY,
    columns: Math.max(columns.length, 1),
    positions: positions,
    stackIndex: stackIndex,
  };
}

function gutterRoom(routes: EdgeRoutes, room: LaneRoom): Map<number, number> {
  const lanesByGutter = new Map<number, number[]>();
  const xs = [
    ...[...routes.agent.values()].flatMap((route) => route.gutter?.x ?? []),
    ...[...routes.side.values()].flatMap((route) => [
      route.sourceX,
      route.targetX,
    ]),
  ];
  for (const x of xs) {
    let boundary = 0;
    while (x > columnLeft(boundary, room) + widthOf(boundary, room) / 2) {
      boundary++;
    }
    if (boundary === 0) continue;
    lanesByGutter.set(boundary, [...(lanesByGutter.get(boundary) ?? []), x]);
  }
  const gutters = new Map(room.gutters);
  for (const [boundary, lanes] of lanesByGutter) {
    // An arrow's run clear of the box on each side, so no lane lands in a neighbour.
    const needed = Math.max(...lanes) - Math.min(...lanes) + ARROW_RUN * 2;
    const width =
      columnLeft(boundary, room) -
      columnLeft(boundary - 1, room) -
      widthOf(boundary - 1, room);
    if (needed > width) {
      gutters.set(
        boundary,
        (room.gutters.get(boundary) ?? 0) + roundUpToGrid(needed - width),
      );
    }
  }

  return gutters;
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

function orderAgents(graph: CanvasGraph): LayoutNode[] {
  const childrenOf = new Map<string, LayoutNode[]>();
  const roots: LayoutNode[] = [];
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

// Group columns move to where side edges cross the fewest columns. Only a strict gain moves
// one, so without side edges the type order holds.
function orderColumns(
  typed: readonly ColumnItem[][],
  context: LayoutContext,
  place: BlockPlace | null,
): ColumnItem[][] {
  let order = typed.flatMap((column): ColumnItem[][] =>
    column.every((item) => "group" in item)
      ? column.map((item) => [item])
      : [column],
  );
  const movable = order.flatMap((column, index) =>
    column.length === 1 && "group" in column[0] ? [index] : [],
  );
  if (movable.length < 2) return order;
  const [first, last] = [movable[0], movable[movable.length - 1]];
  const columnOf = new Map<string, readonly ColumnItem[]>();
  for (const column of order) {
    for (const item of column) {
      for (const id of "node" in item ? [item.node.id] : item.group.memberIds) {
        columnOf.set(id, column);
      }
    }
  }
  const pairs = context.sidePairs.filter(
    ([a, b]) => columnOf.has(a) || columnOf.has(b),
  );
  if (pairs.length === 0) return order;
  const linked = new Set(
    pairs.flatMap(([a, b]) => [columnOf.get(a), columnOf.get(b)]),
  );
  const cost = (candidate: readonly (readonly ColumnItem[])[]): number => {
    const indexOf = new Map(candidate.map((column, index) => [column, index]));
    const at = (id: string): number | undefined => {
      const column = columnOf.get(id);

      return column === undefined ? undefined : indexOf.get(column);
    };
    let total = 0;
    for (const [a, b] of pairs) {
      const [atA, atB] = [at(a), at(b)];
      if (atA !== undefined && atB !== undefined) {
        total += Math.max(0, Math.abs(atA - atB) - 1);
        continue;
      }
      const inside = atA ?? atB ?? 0;
      const outsideRank = place?.ranks.get(atA === undefined ? a : b);
      if (!place || outsideRank === undefined || outsideRank === place.rank) {
        continue;
      }
      total +=
        outsideRank < place.rank ? inside : candidate.length - 1 - inside;
    }

    return total;
  };
  let best = cost(order);
  for (let improved = true; improved;) {
    improved = false;
    for (let from = first; from <= last; from++) {
      if (!linked.has(order[from]) || !("group" in order[from][0])) continue;
      for (let to = first; to <= last; to++) {
        if (to === from) continue;
        const next = [...order];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        const score = cost(next);
        if (score < best) {
          order = next;
          best = score;
          improved = true;
        }
      }
    }
  }

  return order;
}

// Nearest first, below/right before above/left, so a nudged card stays inside the graph.
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

function sameRoom(a: LaneRoom, b: LaneRoom): boolean {
  return (
    a.bus === b.bus &&
    a.stack === b.stack &&
    a.under === b.under &&
    a.gutters.size === b.gutters.size &&
    [...a.gutters].every(([boundary, px]) => b.gutters.get(boundary) === px)
  );
}

function sidePairs(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpServers: McpServersByNode,
  states: ReadonlyMap<string, WorkspaceSandboxIds>,
): [string, string, string][] {
  const types = new Map(nodes.map((node) => [node.id, node.type]));

  return [
    ...edges.flatMap((edge): [string, string, string][] =>
      edgeKind(edge) === "mount" &&
      types.get(edge.source) !== "agent" &&
      types.get(edge.target) !== "agent"
        ? [[edge.source, edge.target, "mount"]]
        : [],
    ),
    ...[...states].flatMap(
      ([workspaceId, state]): [string, string, string][] =>
        state.kind === "inherited"
          ? state.sandboxIds.map((sandboxId): [string, string, string] => [
              workspaceId,
              sandboxId,
              "inherits",
            ])
          : [],
    ),
    ...[...runsOnSandboxIds(nodes, mcpServers)].map(
      ([mcpId, sandboxId]): [string, string, string] => [
        mcpId,
        sandboxId,
        "runs-on",
      ],
    ),
  ];
}

function snapToGrid(position: LayoutPosition): LayoutPosition {
  return {
    x: Math.round(position.x / GRID) * GRID,
    y: Math.round(position.y / GRID) * GRID,
  };
}

function spreadCells(
  cells: Cells,
  room: LaneRoom,
): Map<string, LayoutPosition> {
  return new Map(
    [...cells.positions].map(([id, position]): [string, LayoutPosition] => {
      const column = Math.floor(position.x / COLUMN_UNIT);
      const below = position.y >= cells.serviceTop;

      return [
        id,
        {
          x: position.x + columnLeft(column, room) - column * COLUMN_UNIT,
          y:
            position.y +
            (below ? room.bus : 0) +
            (cells.stackIndex.get(id) ?? 0) * room.stack +
            (cells.parked.has(id) ? room.under : 0),
        },
      ];
    }),
  );
}

function stackShortfall(
  agentEdges: readonly AgentEdgeRequest[],
  boxes: ReadonlyMap<string, LayoutRect>,
  routes: EdgeRoutes,
): number {
  return Math.max(
    0,
    ...agentEdges.flatMap((edge) => {
      const target = boxes.get(edge.target);
      const route = routes.agent.get(edge.id);
      if (!target || !route?.gutter) return [];
      const approachY = target.y - route.gutter.rise;
      const run: LayoutRect = {
        height: 0,
        width: Math.abs(route.gutter.x - (target.x + target.width / 2)),
        x: Math.min(route.gutter.x, target.x + target.width / 2),
        y: approachY - LANE_SPACING,
      };
      const above = [...boxes.values()].filter(
        (box) =>
          box !== target &&
          box.y < target.y &&
          box.x < run.x + run.width &&
          run.x < box.x + box.width,
      );

      return above.map((box) => box.y + box.height - run.y);
    }),
  );
}

function underShortfall(
  routes: EdgeRoutes,
  boxes: ReadonlyMap<string, LayoutRect>,
  parked: ReadonlySet<string>,
): number {
  const parkedTop = Math.min(
    ...[...parked].flatMap((id) => {
      const box = boxes.get(id);

      return box ? [box.y] : [];
    }),
  );
  if (!Number.isFinite(parkedTop)) return 0;

  return Math.max(
    0,
    ...[...routes.side.values()].flatMap((route) =>
      route.underY === null ? [] : [route.underY + STACK_GAP - parkedTop],
    ),
  );
}

function widthOf(column: number, room: LaneRoom): number {
  return room.widths.get(column) ?? NODE_WIDTH;
}
