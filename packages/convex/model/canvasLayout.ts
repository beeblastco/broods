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
 * several agents reach sit in a block after the middle one of those agents,
 * so their edges stay short from both sides; services no agent reaches park
 * in a lane below. A mount edge ties its two cards together: an agent that
 * reaches one reaches the other, so a mounted pair always lands in the same
 * block. Groups come from `canvasFrames.ts`, so the dashboard reads back the
 * same frames the layout packed.
 *
 * Columns are as wide as their widest box plus a gutter, and cards as tall as
 * {@link cardHeight} says, the height the dashboard renders them at. The gap
 * under the agent row, each gutter, the gap between stacked boxes and the gap
 * above the parked lane grow, in grid steps, until the lanes routed through
 * them fit. The lanes come from `canvasEdgeRoutes.ts`, the same router the
 * dashboard draws with.
 */

import type { CanvasNode } from "../canvas";
import {
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
  agentRefCounts,
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
  runsOnSandboxIds,
  sandboxOrderNumbers,
  workspaceSandboxIds,
  type CanvasFrame,
  type McpServersByNode,
} from "./canvasFrames";

/** Card box, matching `w-44 min-h-24` on the node shell in `BaseNode.tsx`. */
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 96;

/** Background dot pitch. Drags snap to it, and cell sizes are multiples of it. */
export const GRID = 24;

/** Gap under a stacked box, and under the agent row before its bus needs more. */
const STACK_GAP = 48;

/** Top of the service row under agents of the usual height. */
export const SERVICE_TOP = NODE_HEIGHT + STACK_GAP;

/**
 * A card's rows, in px at the card's own scale, as `BaseNode.tsx` renders
 * them: top padding, one title line, the status row (with its globe badge),
 * and the extra rows. A title or workspace state line wraps at about the
 * character counts below, at most twice.
 */
const CARD_FEATURE_ROW = 18;
const CARD_LINE = 16;
const CARD_ROW_GAP = 6;
const CARD_SHARED_ROW = 20;
const CARD_STATE_CHARS = 22;
const CARD_STATUS_ROW = 38;
const CARD_SUBTITLE_ROW = 20;
const CARD_TITLE_CHARS = 20;
const CARD_TOP_PADDING = 10;

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

/**
 * Widen-and-reroute rounds. Room only grows, so the rounds settle; the cap
 * only guards against a bug looping forever.
 */
const MAX_LANE_PASSES = 32;

/**
 * Column order of an agent's service types. Within the MCP, sandbox and
 * workspace types each group takes a column, ordered by the side edges between
 * them (see {@link orderByLinks}), so a runs-on edge and a mount or inherited
 * edge each cross one gutter. Exhaustive over the node types on purpose:
 * adding one to `canvasNodeValidator` without giving it a column is a compile
 * error here.
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

/** Column left edges already worked out, per room. */
const COLUMN_LEFTS = new WeakMap<LaneRoom, number[]>();

/**
 * What decides a card's height beyond its title: extra feature rows, the
 * subtitle, a workspace's state line, and how many agents share it.
 */
export type CardFacts = {
  features: number;
  refCount: number;
  stateText: string | null;
  subtitle: boolean;
};

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

/**
 * Nodes in cell space: x is a column index times COLUMN_UNIT (plus a chip's
 * inset), y already in pixels, before any room is added.
 */
type Cells = {
  /** Unwired cards in the lane below everything. */
  parked: ReadonlySet<string>;
  positions: Map<string, LayoutPosition>;
  /** Top of the service row. */
  serviceTop: number;
  /** How many boxes sit above each box in its column. */
  stackIndex: Map<string, number>;
};

/** One box a column holds: a group (a frame, or a card with one member) or an ungrouped card. */
type ColumnItem = { group: CanvasFrame } | { node: LayoutNode };

/**
 * Column widths, and pixels added on top of the minimum spacing: under the
 * agent row, per gutter (keyed by the column right of it), between stacked
 * boxes, and above the parked lane.
 */
type LaneRoom = {
  bus: number;
  gutters: Map<number, number>;
  stack: number;
  under: number;
  widths: ReadonlyMap<number, number>;
};

/** The facts every block reads while it places services. */
type LayoutContext = {
  groups: readonly CanvasFrame[];
  heights: ReadonlyMap<string, number>;
  /** Side-edge ends, as node id pairs. */
  sidePairs: readonly (readonly [string, string])[];
  types: ReadonlyMap<string, string | undefined>;
};

/** A block of columns, and how far down it reaches. */
type LayoutBlock = {
  /** Below the lowest placed box and its gap, or the origin when empty. */
  bottomY: number;
  columns: number;
  positions: Map<string, LayoutPosition>;
  stackIndex: Map<string, number>;
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
  mcpServers: McpServersByNode,
): T[] {
  return applyPositions(nodes, tidyCanvasLayout(nodes, edges, mcpServers));
}

/**
 * A card's height from its rows, as `BaseNode.tsx` renders it at its own
 * scale. The card takes this as its minimum height, so as long as the rows fit
 * (the estimate is generous) the canvas measures exactly this, and the tidy
 * layout stacks cards at the heights they draw at.
 */
export function cardHeight(label: string, facts: CardFacts): number {
  const titleLines = lineCount(label, CARD_TITLE_CHARS);
  const stateLines =
    facts.stateText === null ? 0 : lineCount(facts.stateText, CARD_STATE_CHARS);
  const rows =
    CARD_TOP_PADDING +
    titleLines * CARD_LINE +
    (facts.subtitle ? CARD_SUBTITLE_ROW : 0) +
    (facts.features > 0
      ? CARD_ROW_GAP + facts.features * CARD_FEATURE_ROW
      : 0) +
    (stateLines > 0 ? CARD_ROW_GAP + stateLines * CARD_LINE : 0) +
    (facts.refCount >= 2 ? CARD_SHARED_ROW : 0) +
    CARD_STATUS_ROW;

  return Math.max(NODE_HEIGHT, rows);
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

/**
 * Every node's tidy position. Lays out cells, then routes every edge and
 * grows the room between cells until the routes fit; the layout it returns is
 * always one it routed and checked.
 */
export function tidyCanvasLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpServers: McpServersByNode,
): Map<string, LayoutPosition> {
  const groups = deriveCanvasGroups(nodes, edges, mcpServers);
  const frames = framesOf(groups);
  const context: LayoutContext = {
    groups: groups,
    heights: cardHeights(nodes, edges, mcpServers),
    sidePairs: sidePairs(nodes, edges, mcpServers),
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

/**
 * The state line a workspace card shows after its arrow: "a, b · mounted",
 * "a · inherited" or "read-only". Shared with the card, so the height estimate
 * counts the text the card draws.
 */
export function workspaceStateText(
  kind: "inherited" | "override" | "readonly",
  sandboxLabels: readonly string[],
): string {
  if (kind === "readonly") return "read-only";

  return `${sandboxLabels.join(", ")} · ${kind === "override" ? "mounted" : "inherited"}`;
}

/** How far the deepest bus lane under any agent runs past the gap below it. */
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

/**
 * Each node's height as a card, from the same facts the dashboard reads: its
 * subtitle (a session's store line, an MCP server's transport, a sandbox's
 * place or computer), a persistent sandbox's feature row, a workspace's state
 * line, and how many agents share a sandbox or workspace.
 */
function cardHeights(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpServers: McpServersByNode,
): Map<string, number> {
  const orderNumbers = sandboxOrderNumbers(nodes, edges);
  const refCounts = agentRefCounts(nodes, edges);
  const states = workspaceSandboxIds(nodes, edges);
  const labels = new Map(nodes.map((node) => [node.id, labelOf(node)]));

  return new Map(
    nodes.map((node): [string, number] => {
      const config: unknown = node.data.config;
      const machine =
        typeof config === "object" &&
        config !== null &&
        "provider" in config &&
        config.provider === "machine";
      const persistent =
        typeof config === "object" &&
        config !== null &&
        "persistent" in config &&
        config.persistent === true;
      const state = states.get(node.id);
      const facts: CardFacts = {
        features: node.type === "sandbox" && persistent && !machine ? 1 : 0,
        refCount:
          node.type === "sandbox" || node.type === "workspace"
            ? (refCounts.get(node.id) ?? 0)
            : 0,
        stateText: state
          ? workspaceStateText(
              state.kind,
              state.kind === "readonly"
                ? []
                : state.sandboxIds.map((id) => labels.get(id) ?? id),
            )
          : null,
        subtitle:
          node.type === "database" ||
          (node.type === "mcp" && mcpServers.has(node.id)) ||
          (node.type === "sandbox" && (machine || orderNumbers.has(node.id))),
      };

      return [node.id, cardHeight(labelOf(node), facts)];
    }),
  );
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
 * Nodes in cell space: agents on top, each over its block of services, a
 * block of shared services after the middle agent that reaches them, unwired
 * ones parked below.
 */
function cellLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  context: LayoutContext,
): Cells {
  const graph = indexGraph(nodes, edges);
  const agents = orderAgents(graph);
  const rank = new Map(agents.map((agent, index) => [agent.id, index]));
  const sharedAfter = new Map<string, LayoutNode[]>();
  for (const { node, owners } of graph.sharedServices) {
    const ranked = [...owners].sort(
      (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
    );
    const anchor = ranked[Math.floor((ranked.length - 1) / 2)];
    sharedAfter.set(anchor, [...(sharedAfter.get(anchor) ?? []), node]);
  }
  const serviceTop = roundUpToGrid(
    Math.max(
      NODE_HEIGHT,
      ...agents.map((agent) => context.heights.get(agent.id) ?? NODE_HEIGHT),
    ) + STACK_GAP,
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
    const services = graph.exclusiveServices.get(agent.id) ?? [];
    const block = layoutBlock(services, context, cursorColumn, serviceTop);
    // Middle column of the block; the left one of the two when the count is even.
    const column = cursorColumn + Math.floor((block.columns - 1) / 2);
    positions.set(agent.id, { x: column * COLUMN_UNIT, y: 0 });
    place(block);
    cursorColumn += block.columns;
    const shared = sharedAfter.get(agent.id);
    if (shared) {
      const sharedBlock = layoutBlock(
        shared,
        context,
        cursorColumn,
        serviceTop,
      );
      place(sharedBlock);
      cursorColumn += sharedBlock.columns;
    }
  }
  const parked = layoutBlock(
    graph.orphanServices,
    context,
    0,
    deepestY + STACK_GAP,
  );
  // Left-aligned, so unwired cards read as parked rather than part of the graph.
  place(parked);

  return {
    parked: new Set(parked.positions.keys()),
    positions: positions,
    serviceTop: serviceTop,
    stackIndex: stackIndex,
  };
}

/** A typed column's groups in group order, then its ungrouped cards by label. */
function columnItems(
  column: readonly LayoutNode[],
  groups: readonly CanvasFrame[],
): ColumnItem[] {
  const ids = new Set(column.map((node) => node.id));
  const grouped = groups.filter((group) =>
    group.memberIds.some((id) => ids.has(id)),
  );
  const groupedIds = new Set(grouped.flatMap((group) => group.memberIds));

  return [
    ...grouped.map((group) => ({ group: group })),
    ...column
      .filter((node) => !groupedIds.has(node.id))
      .map((node) => ({ node: node })),
  ];
}

/**
 * Left edge of a column: every column before it, its gutter and that gutter's
 * room, on the grid. Each room's edges are worked out once, left to right,
 * since routing asks for them per lane and per node.
 */
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
 * edge per agent and frame or card, and a side edge per mount, inherited
 * sandbox and runs-on link. Also the top-level boxes they run between and
 * around.
 */
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
      height: context.heights.get(id) ?? NODE_HEIGHT,
      width: NODE_WIDTH,
    });
  }

  const isAgent = (id: string): boolean => context.types.get(id) === "agent";
  const agentEdges = new Map<string, AgentEdgeRequest>();
  for (const edge of edges) {
    // The dashboard draws agent→service, but an edge can arrive reversed.
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
          height: FRAME_CHIP_HEIGHTS[frame.kind],
          width: FRAME_CHIP_WIDTH,
        }
      : boxes.get(id);
  };
  const sideEdges = context.sidePairs.flatMap(([a, b]): SideEdgeRequest[] => {
    const boxA = handleBox(a);
    const boxB = handleBox(b);
    if (!boxA || !boxB) return [];

    return [
      {
        id: `${a}|${b}`,
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

/**
 * Gutter room grown where the vertical lanes routed through a gutter span
 * more than its width, keeping a lane's width clear of the boxes either side.
 */
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
    // The gutter right of a column's centre and left of the next one's.
    let boundary = 0;
    while (x > columnLeft(boundary, room) + widthOf(boundary, room) / 2) {
      boundary++;
    }
    if (boundary === 0) continue;
    lanesByGutter.set(boundary, [...(lanesByGutter.get(boundary) ?? []), x]);
  }
  const gutters = new Map(room.gutters);
  for (const [boundary, lanes] of lanesByGutter) {
    const needed = Math.max(...lanes) - Math.min(...lanes) + LANE_SPACING * 2;
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

function labelOf(node: LayoutNode): string {
  return typeof node.data.label === "string" ? node.data.label : node.id;
}

/**
 * `room` grown wherever the lanes routed at `positions` do not fit: the bus
 * gap under an agent, a column gutter, the gap above a box an approach lane
 * runs in, and the gap above the parked lane a side edge detours through.
 */
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

/**
 * Place services as columns growing right from `originColumn`, each column
 * stacking down from `originY` with a STACK_GAP under every box. A sandbox,
 * workspace or MCP group takes a column of its own, ordered by its side
 * edges; any other type shares one. An empty block still claims one column
 * for its agent.
 */
function layoutBlock(
  services: readonly LayoutNode[],
  context: LayoutContext,
  originColumn: number,
  originY: number,
): LayoutBlock {
  const columns = orderByLinks(
    groupIntoColumns(services).map((column) =>
      columnItems(column, context.groups),
    ),
    context,
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
        y = roundUpToGrid(
          y + (context.heights.get(id) ?? NODE_HEIGHT) + STACK_GAP,
        );

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

/** Lines a text wraps to at `perLine` characters, one or two. */
function lineCount(text: string, perLine: number): number {
  return text.length > perLine ? 2 : 1;
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
 * A block's columns, one per MCP, sandbox and workspace group, ordered so side
 * edges cross one gutter: the sandbox group most linked to workspaces sits
 * rightmost, next to the workspace group most linked to it; the sandbox group
 * most linked to MCP servers sits leftmost, next to the MCP group most linked
 * to it. Other types keep one stacked column. Sorts are stable, so unlinked
 * groups keep their group order.
 */
function orderByLinks(
  typed: readonly ColumnItem[][],
  context: LayoutContext,
): ColumnItem[][] {
  const membersOf = (item: ColumnItem): Set<string> =>
    new Set("node" in item ? [item.node.id] : item.group.memberIds);
  const links = (item: ColumnItem, test: (id: string) => boolean): number => {
    const members = membersOf(item);

    return context.sidePairs.filter(
      ([a, b]) => (members.has(a) && test(b)) || (members.has(b) && test(a)),
    ).length;
  };
  const ofType = (type: string): ((id: string) => boolean) => {
    return (id) => context.types.get(id) === type;
  };
  const ofItem = (item: ColumnItem | undefined): ((id: string) => boolean) => {
    const members = item ? membersOf(item) : new Set<string>();

    return (id) => members.has(id);
  };
  const itemsOf = (type: string): ColumnItem[] =>
    typed.find((column) => {
      const [first] = column;

      return (
        first !== undefined &&
        "group" in first &&
        column.every((item) => "group" in item) &&
        first.group.kind === type
      );
    }) ?? [];

  const sandboxes = [...itemsOf("sandbox")].sort(
    (a, b) =>
      links(a, ofType("workspace")) -
      links(a, ofType("mcp")) -
      (links(b, ofType("workspace")) - links(b, ofType("mcp"))),
  );
  const mcps = [...itemsOf("mcp")].sort(
    (a, b) => links(a, ofItem(sandboxes[0])) - links(b, ofItem(sandboxes[0])),
  );
  const workspaces = [...itemsOf("workspace")].sort(
    (a, b) =>
      links(b, ofItem(sandboxes.at(-1))) - links(a, ofItem(sandboxes.at(-1))),
  );
  const ordered = new Map([
    ["mcp", mcps],
    ["sandbox", sandboxes],
    ["workspace", workspaces],
  ]);

  return typed.flatMap((column) => {
    const [first] = column;
    const kind =
      first !== undefined && "group" in first ? first.group.kind : "";
    const reordered = ordered.get(kind);

    return reordered && reordered.length === column.length
      ? reordered.map((item) => [item])
      : [column];
  });
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

function sameRoom(a: LaneRoom, b: LaneRoom): boolean {
  return (
    a.bus === b.bus &&
    a.stack === b.stack &&
    a.under === b.under &&
    a.gutters.size === b.gutters.size &&
    [...a.gutters].every(([boundary, px]) => b.gutters.get(boundary) === px)
  );
}

/**
 * Node id pairs every side edge joins: a mount between two services, a
 * workspace and each sandbox it inherits, and a machine MCP server and the
 * sandbox it runs on.
 */
function sidePairs(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpServers: McpServersByNode,
): [string, string][] {
  const types = new Map(nodes.map((node) => [node.id, node.type]));

  return [
    ...edges.flatMap((edge): [string, string][] =>
      edgeKind(edge) === "mount" &&
      types.get(edge.source) !== "agent" &&
      types.get(edge.target) !== "agent"
        ? [[edge.source, edge.target]]
        : [],
    ),
    ...[...workspaceSandboxIds(nodes, edges)].flatMap(
      ([workspaceId, state]): [string, string][] =>
        state.kind === "inherited"
          ? state.sandboxIds.map((sandboxId) => [workspaceId, sandboxId])
          : [],
    ),
    ...runsOnSandboxIds(nodes, mcpServers),
  ];
}

function snapToGrid(position: LayoutPosition): LayoutPosition {
  return {
    x: Math.round(position.x / GRID) * GRID,
    y: Math.round(position.y / GRID) * GRID,
  };
}

/** Cell positions at their columns' real left edges, pushed down by the room above them. */
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

/**
 * How far an approach lane runs into the box above its target: the lane must
 * keep a lane's width below every box it passes over.
 */
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

/**
 * How far a side edge's detour lane runs into the parked lane below it, with
 * a stack gap to spare.
 */
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
