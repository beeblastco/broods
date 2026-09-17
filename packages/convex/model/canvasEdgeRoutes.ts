/**
 * Lanes for the edges the canvas draws, shared by the dashboard, which draws
 * them, and the tidy layout, which leaves room for them.
 *
 * An agent edge leaves the agent's bottom and enters its target's top. With
 * nothing between the two it drops to a bus under the agent, runs across and
 * drops in. Otherwise it runs along the bus to the gutter beside the target,
 * down the gutter to the gap above the target, across and down into its top.
 *
 * A side edge (mount, runs-on, inherited sandbox) joins two side handles.
 * Between facing handles with nothing in the way it is one step, its vertical
 * run in the gap between them. Otherwise it leaves into the gutter beside its
 * own box, runs under every box between the two ends and comes up the gutter
 * beside the other box.
 *
 * One agent's edges share a trunk and branch off it, like an org chart. Every
 * other run gets its own lane, at least LANE_SPACING from any parallel run of
 * another agent or side edge it shares a stretch with, so no two edges draw
 * over each other. Edges that share a handle fan out along its side.
 *
 * Pure on purpose: the dashboard imports it, so no Convex server imports.
 */

import type { LayoutPosition, LayoutRect } from "./canvasLayout";

/** Above a target's top, or below the boxes a side edge runs under, the first lane. */
const APPROACH_INSET = 12;

/** How far past its ends one agent's bus keeps other agents' buses off its lane. */
const BUS_END_GAP = 24;

/** Below an agent's bottom, the first bus lane. */
export const BUS_INSET = 12;

/** Distance between two agents' buses, wider than other lanes so each reads as its own line. */
const BUS_SPACING = 16;

/** Kept clear at both ends of a box's top that several agent edges fan across. */
const FAN_INSET = 16;

/** Between a box's side and the gutter lane nearest it. */
const GUTTER_INSET = 8;

/** Distance between two parallel runs. */
export const LANE_SPACING = 8;

/** Kept clear at both ends of a box's side that several side edges fan along. */
const SIDE_FAN_INSET = 8;

/** How far apart edges sharing a side handle spread at most. */
const SIDE_FAN_SPACING = 24;

/**
 * How far below a box's top its side handles sit at most: a card's side
 * handles hold at `top-12` in `BaseNode.tsx`, so cards of different heights
 * in one row line up; a chip or collapsed frame is shorter, so its handles
 * sit at its middle.
 */
const SIDE_HANDLE_TOP = 48;

/** Lane candidates a straight side step tries before it detours. */
const STEP_TRIES = 5;

/** How far apart edges entering one target's top spread at most. */
const TARGET_FAN_SPACING = 16;

/** An agent edge between two boxes on the board, by box id. */
export type AgentEdgeRequest = { id: string; source: string; target: string };

/**
 * An agent edge's lanes. `busDrop`, `gutter.rise` and `targetFan` are relative
 * to its handles, so they hold while a drag moves an end; `gutter.x` is
 * absolute, beside the target's column.
 */
export type AgentEdgeRoute = {
  /** From the agent's bottom down to this edge's bus lane. */
  busDrop: number;
  /** The gutter lane, and how far above the target the approach lane runs; null for a straight drop. */
  gutter: { rise: number; x: number } | null;
  /** Along the target's top, from its centre. */
  targetFan: number;
};

export type EdgeRoutes = {
  agent: Map<string, AgentEdgeRoute>;
  side: Map<string, SideEdgeRoute>;
};

export type HandleSide = "bottom" | "left" | "right" | "top";

/** A side edge between two side handles. */
/**
 * A side edge between two side handles. `kind` (mount, inherits, runs-on)
 * says which edges may merge where a handle is too crowded to fan them apart.
 */
export type SideEdgeRequest = {
  id: string;
  kind: string;
  source: SideEnd;
  target: SideEnd;
};

/**
 * A side edge's lanes: how far along its side each end fans, and the x of the
 * vertical run at each end. With `underY` null the two xs are one run between
 * facing handles; otherwise the edge runs under the boxes at `underY`.
 */
export type SideEdgeRoute = {
  sourceFan: number;
  sourceX: number;
  targetFan: number;
  targetX: number;
  underY: number | null;
};

/**
 * One end of a side edge: the box its handle sits on (a chip or a card), the
 * node it belongs to, the top-level box holding it (the chip's frame, or the
 * card itself), and which side the handle is on.
 */
export type SideEnd = {
  box: LayoutRect;
  nodeId: string;
  outerId: string;
  side: "left" | "right";
};

/** An agent edge while its lanes are being picked. */
type Leg = {
  /** Whether a box sits between the agent and the target, so the edge takes a gutter. */
  blocked: boolean;
  busY: number;
  end: LayoutPosition;
  gutterX: number | null;
  id: string;
  request: AgentEdgeRequest;
  start: LayoutPosition;
  target: LayoutRect;
  targetFan: number;
};

/**
 * A straight run taken so far: `at` is its x (vertical) or y (horizontal),
 * `from`..`to` its extent, `owner` the agent (or side edge) it belongs to.
 */
type Run = { at: number; from: number; owner: string; to: number };

/**
 * Runs taken so far on one axis, bucketed by `at` in LANE_SPACING steps, so a
 * lane check reads only the runs near it rather than every run on the board.
 */
type Runs = Map<number, Run[]>;

/** The corner points of an agent edge, from the agent's bottom handle to the target's top handle. */
export function agentEdgePoints(
  source: LayoutPosition,
  target: LayoutPosition,
  route: AgentEdgeRoute,
): LayoutPosition[] {
  const end = { x: target.x + route.targetFan, y: target.y };
  const busY = source.y + route.busDrop;
  if (!route.gutter) {
    return [source, { x: source.x, y: busY }, { x: end.x, y: busY }, end];
  }
  const approachY = target.y - route.gutter.rise;

  return [
    source,
    { x: source.x, y: busY },
    { x: route.gutter.x, y: busY },
    { x: route.gutter.x, y: approachY },
    { x: end.x, y: approachY },
    end,
  ];
}

/**
 * Ids of the boxes an orthogonal polyline passes through, whole segments and
 * not just corners, skipping `ignore`. Touching a box's edge does not count.
 */
export function crossedBoxIds(
  points: readonly LayoutPosition[],
  boxes: ReadonlyMap<string, LayoutRect>,
  ignore: ReadonlySet<string>,
): string[] {
  const crossed = new Set<string>();
  points.slice(1).forEach((point, index) => {
    const from = points[index];
    for (const [id, box] of boxes) {
      if (!ignore.has(id) && segmentCrosses(from, point, box)) crossed.add(id);
    }
  });

  return [...crossed];
}

/** The side of `box` that faces `other`, left or right. */
export function facingSide(
  box: LayoutRect,
  other: LayoutRect,
): "left" | "right" {
  return other.x + other.width / 2 < box.x + box.width / 2 ? "left" : "right";
}

/** Where React Flow puts a box's handle on one side. */
export function handlePoint(box: LayoutRect, side: HandleSide): LayoutPosition {
  if (side === "top") return { x: box.x + box.width / 2, y: box.y };
  if (side === "bottom") {
    return { x: box.x + box.width / 2, y: box.y + box.height };
  }

  return {
    x: side === "left" ? box.x : box.x + box.width,
    y: box.y + Math.min(box.height / 2, SIDE_HANDLE_TOP),
  };
}

/**
 * Lanes for every agent and side edge. `boxes` holds every top-level box on
 * the board (agents, cards, frames); edges run between them and around the
 * rest. An agent's edges share one trunk: one drop, one bus, and one lane per
 * gutter, branching off where each one turns. Gutter lanes go first, nearest
 * target first, so a deeper one takes the outer lane.
 */
export function routeCanvasEdges(
  boxes: ReadonlyMap<string, LayoutRect>,
  agentEdges: readonly AgentEdgeRequest[],
  sideEdges: readonly SideEdgeRequest[],
): EdgeRoutes {
  const verticals: Runs = new Map();
  const horizontals: Runs = new Map();
  const legs = agentLegs(boxes, agentEdges);

  for (const leg of legs
    .filter((item) => item.blocked)
    .sort((a, b) => a.end.y - b.end.y || a.id.localeCompare(b.id))) {
    const toLeft = leg.start.x <= leg.end.x;
    leg.gutterX = takeLane(
      verticals,
      leg.request.source,
      toLeft
        ? leg.target.x - GUTTER_INSET
        : leg.target.x + leg.target.width + GUTTER_INSET,
      toLeft ? -1 : 1,
      leg.start.y,
      leg.end.y,
      LANE_SPACING,
    );
  }

  const { fans, owners } = sideFans(sideEdges);
  const side = new Map(
    [...sideEdges]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((edge): [string, SideEdgeRoute] => [
        edge.id,
        routeSide(
          edge,
          owners.get(edge.id) ?? edge.id,
          fans.get(`${edge.id}:source`) ?? 0,
          fans.get(`${edge.id}:target`) ?? 0,
          boxes,
          verticals,
          horizontals,
        ),
      ]),
  );

  // Edges from different agents into one target fan across its top, in the
  // order they arrive, so they never share the final drop.
  for (const group of groupBy(legs, (leg) => leg.request.target)) {
    group.sort(
      (a, b) =>
        (a.gutterX ?? a.start.x) - (b.gutterX ?? b.start.x) ||
        a.id.localeCompare(b.id),
    );
    fanOffsets(
      group.length,
      group[0].target.width,
      FAN_INSET,
      TARGET_FAN_SPACING,
    ).forEach((offset, index) => {
      group[index].targetFan = offset;
    });
  }

  placeBuses(legs, horizontals);

  const agent = new Map<string, AgentEdgeRoute>();
  for (const leg of [...legs].sort(
    (a, b) => a.end.y - b.end.y || a.id.localeCompare(b.id),
  )) {
    const gutterX = leg.gutterX;
    let gutter: AgentEdgeRoute["gutter"] = null;
    if (gutterX !== null) {
      const to = leg.end.x + leg.targetFan;
      const approachY = takeLane(
        horizontals,
        leg.request.source,
        leg.end.y - APPROACH_INSET,
        -1,
        Math.min(gutterX, to) - LANE_SPACING,
        Math.max(gutterX, to) + LANE_SPACING,
        LANE_SPACING,
      );
      gutter = { rise: leg.end.y - approachY, x: gutterX };
    }
    agent.set(leg.id, {
      busDrop: leg.busY - leg.start.y,
      gutter: gutter,
      targetFan: leg.targetFan,
    });
  }

  return { agent: agent, side: side };
}

/** The corner points of a side edge, from its source handle to its target handle. */
export function sideEdgePoints(
  source: LayoutPosition,
  target: LayoutPosition,
  route: SideEdgeRoute,
): LayoutPosition[] {
  const start = { x: source.x, y: source.y + route.sourceFan };
  const end = { x: target.x, y: target.y + route.targetFan };
  if (route.underY === null) {
    return [
      start,
      { x: route.sourceX, y: start.y },
      { x: route.sourceX, y: end.y },
      end,
    ];
  }

  return [
    start,
    { x: route.sourceX, y: start.y },
    { x: route.sourceX, y: route.underY },
    { x: route.targetX, y: route.underY },
    { x: route.targetX, y: end.y },
    end,
  ];
}

function addRun(runs: Runs, run: Run): void {
  const bucket = Math.floor(run.at / LANE_SPACING);
  const list = runs.get(bucket);
  if (list) list.push(run);
  else runs.set(bucket, [run]);
}

/** Agent edges with a box at both ends and room below the agent for a bus. */
function agentLegs(
  boxes: ReadonlyMap<string, LayoutRect>,
  agentEdges: readonly AgentEdgeRequest[],
): Leg[] {
  const boxList = [...boxes];

  return agentEdges.flatMap((request): Leg[] => {
    const source = boxes.get(request.source);
    const target = boxes.get(request.target);
    if (!source || !target) return [];
    const start = handlePoint(source, "bottom");
    const end = handlePoint(target, "top");
    // A target level with or above the agent has no room for a bus.
    if (end.y - start.y < BUS_INSET + APPROACH_INSET) return [];
    const between: LayoutRect = {
      height: end.y - start.y,
      width: Math.abs(end.x - start.x) + LANE_SPACING * 2,
      x: Math.min(start.x, end.x) - LANE_SPACING,
      y: start.y,
    };

    return [
      {
        blocked: boxList.some(
          ([id, box]) =>
            id !== request.source &&
            id !== request.target &&
            overlaps(box, between),
        ),
        busY: start.y,
        end: end,
        gutterX: null,
        id: request.id,
        request: request,
        start: start,
        target: target,
        targetFan: 0,
      },
    ];
  });
}

/** +1 for a handle that leaves rightward, -1 for leftward. */
function directionOf(side: SideEnd["side"]): -1 | 1 {
  return side === "right" ? 1 : -1;
}

/**
 * Offsets that spread `count` edges across a box side `length` long, centred,
 * `spacing` apart, or closer when the side is too short for that, keeping
 * `inset` clear at both ends.
 */
function fanOffsets(
  count: number,
  length: number,
  inset: number,
  spacing: number,
): number[] {
  const room = Math.max(length - inset * 2, 0);
  const step = count < 2 ? 0 : Math.min(spacing, room / (count - 1));

  return Array.from(
    { length: count },
    (_, index) => (index - (count - 1) / 2) * step,
  );
}

/**
 * The first lane from `base` that keeps `spacing` from every run of another
 * owner it shares a stretch with, stepping one way (`direction` ±1) or
 * alternating around `base` (0). Does not record it.
 */
function findLane(
  runs: Runs,
  owner: string,
  base: number,
  direction: -1 | 0 | 1,
  from: number,
  to: number,
  spacing: number,
): number {
  for (let step = 0; ; step++) {
    // Alternating: 0, +1, -1, +2, -2 lanes.
    const offset =
      direction === 0
        ? (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2)
        : direction * step;
    const at = base + offset * spacing;
    if (runClear(runs, { at: at, from: from, owner: owner, to: to }, spacing)) {
      return at;
    }
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }

  return [...groups.values()];
}

/** The gutter lane nearest a top-level box on one side. */
function gutterBase(box: LayoutRect, side: SideEnd["side"]): number {
  return side === "right"
    ? box.x + box.width + GUTTER_INSET
    : box.x - GUTTER_INSET;
}

function overlaps(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * One bus per agent, spanning every turn it makes. The widest bus takes the
 * shallowest lane; another agent's bus keeps BUS_SPACING from it anywhere
 * within BUS_END_GAP of its ends, so two buses never read as one line.
 */
function placeBuses(legs: readonly Leg[], horizontals: Runs): void {
  const buses = groupBy(legs, (leg) => leg.request.source)
    .map((group) => {
      const turns = group.flatMap((leg) => [
        leg.start.x,
        leg.gutterX ?? leg.end.x + leg.targetFan,
      ]);

      return {
        from: Math.min(...turns) - BUS_END_GAP,
        group: group,
        to: Math.max(...turns) + BUS_END_GAP,
      };
    })
    .sort(
      (a, b) =>
        a.group[0].start.y - b.group[0].start.y ||
        b.to - b.from - (a.to - a.from) ||
        a.group[0].request.source.localeCompare(b.group[0].request.source),
    );
  for (const bus of buses) {
    const [first] = bus.group;
    const busY = takeLane(
      horizontals,
      first.request.source,
      first.start.y + BUS_INSET,
      1,
      bus.from,
      bus.to,
      BUS_SPACING,
    );
    for (const leg of bus.group) leg.busY = busY;
  }
}

/**
 * One side edge's lanes. A straight step when its handles face each other and
 * some lane between them keeps its runs, lead-in legs included, off every
 * other edge's and clear of every box but the two it joins; otherwise a detour
 * under the boxes between them. Its runs belong to its source node, so side
 * edges leaving one node share their lanes, one line that branches.
 */
function routeSide(
  edge: SideEdgeRequest,
  owner: string,
  sourceFan: number,
  targetFan: number,
  boxes: ReadonlyMap<string, LayoutRect>,
  verticals: Runs,
  horizontals: Runs,
): SideEdgeRoute {
  const sourceHandle = handlePoint(edge.source.box, edge.source.side);
  const targetHandle = handlePoint(edge.target.box, edge.target.side);
  const start = { x: sourceHandle.x, y: sourceHandle.y + sourceFan };
  const end = { x: targetHandle.x, y: targetHandle.y + targetFan };
  const ignore = new Set([edge.source.outerId, edge.target.outerId]);
  const facing =
    directionOf(edge.source.side) * (end.x - start.x) > 0 &&
    directionOf(edge.target.side) * (start.x - end.x) > 0;
  const legs = (sourceX: number, targetX: number): Run[] => [
    {
      at: start.y,
      from: Math.min(start.x, sourceX),
      owner: owner,
      to: Math.max(start.x, sourceX),
    },
    {
      at: end.y,
      from: Math.min(end.x, targetX),
      owner: owner,
      to: Math.max(end.x, targetX),
    },
  ];

  if (facing) {
    // A lane's width past each end, so two steps that meet end to end at one
    // x do not read as one line with a jog.
    const top = Math.min(start.y, end.y) - LANE_SPACING;
    const bottom = Math.max(start.y, end.y) + LANE_SPACING;
    const middle = Math.round((start.x + end.x) / 2);
    // Only boxes in the step's span can be crossed, whichever lane it takes.
    const span: LayoutRect = {
      height: bottom - top,
      width: Math.abs(end.x - start.x),
      x: Math.min(start.x, end.x),
      y: top,
    };
    const nearby: LayoutRect[] = [];
    for (const [id, box] of boxes) {
      if (!ignore.has(id) && overlaps(box, span)) nearby.push(box);
    }
    for (let step = 0; step < STEP_TRIES; step++) {
      // Alternating around the middle: 0, +1, -1, +2, -2 lanes.
      const offset = (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2);
      const x = middle + offset * LANE_SPACING;
      const run = { at: x, from: top, owner: owner, to: bottom };
      const path = [start, { x: x, y: start.y }, { x: x, y: end.y }, end];
      if (
        runsClear(verticals, [run]) &&
        runsClear(horizontals, legs(x, x)) &&
        !path
          .slice(1)
          .some((point, index) =>
            nearby.some((box) => segmentCrosses(path[index], point, box)),
          )
      ) {
        addRun(verticals, run);
        for (const leg of legs(x, x)) addRun(horizontals, leg);

        return {
          sourceFan: sourceFan,
          sourceX: x,
          targetFan: targetFan,
          targetX: x,
          underY: null,
        };
      }
    }
  }

  const sourceOuter = boxes.get(edge.source.outerId) ?? edge.source.box;
  const targetOuter = boxes.get(edge.target.outerId) ?? edge.target.box;
  const sourceBase = gutterBase(sourceOuter, edge.source.side);
  const targetBase = gutterBase(targetOuter, edge.target.side);
  const left = Math.min(sourceBase, targetBase);
  const right = Math.max(sourceBase, targetBase);
  const band: LayoutRect = {
    height:
      Math.max(
        sourceOuter.y + sourceOuter.height,
        targetOuter.y + targetOuter.height,
      ) - Math.min(start.y, end.y),
    width: right - left,
    x: left,
    y: Math.min(start.y, end.y),
  };
  let floor = band.y + band.height;
  for (const box of boxes.values()) {
    if (overlaps(box, band)) floor = Math.max(floor, box.y + box.height);
  }
  const underY = takeLane(
    horizontals,
    owner,
    floor + APPROACH_INSET,
    1,
    left - LANE_SPACING,
    right + LANE_SPACING,
    LANE_SPACING,
  );
  const sourceX = takeLane(
    verticals,
    owner,
    sourceBase,
    directionOf(edge.source.side),
    start.y,
    underY,
    LANE_SPACING,
  );
  const targetX = takeLane(
    verticals,
    owner,
    targetBase,
    directionOf(edge.target.side),
    end.y,
    underY,
    LANE_SPACING,
  );
  for (const leg of legs(sourceX, targetX)) addRun(horizontals, leg);

  return {
    sourceFan: sourceFan,
    sourceX: sourceX,
    targetFan: targetFan,
    targetX: targetX,
    underY: underY,
  };
}

/**
 * Whether a candidate run keeps `spacing` from every run of another owner it
 * shares a stretch with, reading only the buckets within `spacing` of it.
 */
function runClear(runs: Runs, candidate: Run, spacing: number): boolean {
  const last = Math.floor((candidate.at + spacing) / LANE_SPACING);
  for (
    let bucket = Math.floor((candidate.at - spacing) / LANE_SPACING);
    bucket <= last;
    bucket++
  ) {
    for (const run of runs.get(bucket) ?? []) {
      if (
        run.owner !== candidate.owner &&
        Math.abs(run.at - candidate.at) < spacing &&
        run.from < candidate.to &&
        candidate.from < run.to
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Whether every candidate run keeps LANE_SPACING from each run of another
 * owner it shares a stretch with.
 */
function runsClear(runs: Runs, candidates: readonly Run[]): boolean {
  return candidates.every((candidate) =>
    runClear(runs, candidate, LANE_SPACING),
  );
}

/** Whether an axis-aligned segment passes through a box's inside. */
function segmentCrosses(
  from: LayoutPosition,
  to: LayoutPosition,
  box: LayoutRect,
): boolean {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);

  return (
    left < box.x + box.width &&
    right > box.x &&
    top < box.y + box.height &&
    bottom > box.y &&
    // A run along a box's edge touches it without passing through.
    (from.y === to.y
      ? from.y > box.y && from.y < box.y + box.height
      : from.x > box.x && from.x < box.x + box.width)
  );
}

/**
 * Fan offsets for side edges sharing a handle, keyed `{edgeId}:source` or
 * `{edgeId}:target`, spread along the handle's side in the order their other
 * ends sit, top to bottom; and who owns each edge's lanes. Edges leaving one
 * node share a slot and an owner, one line that branches. Where a handle is
 * too short to keep its slots a lane apart, edges of one kind there merge
 * into one slot and one owner too, a trunk rather than lines run together.
 */
function sideFans(sideEdges: readonly SideEdgeRequest[]): {
  fans: Map<string, number>;
  owners: Map<string, string>;
} {
  const parents = new Map(sideEdges.map((edge) => [edge.id, edge.id]));
  const find = (id: string): string => {
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root) ?? root;
    parents.set(id, root);

    return root;
  };
  const union = (ids: readonly string[]): void => {
    const [first, ...rest] = ids.map(find);
    for (const root of rest) {
      if (root !== first) parents.set(root, first);
    }
  };
  const ends = sideEdges.flatMap((edge) => [
    {
      edge: edge,
      end: edge.source,
      key: `${edge.id}:source`,
      other: edge.target,
      slot: `source:${edge.source.nodeId}`,
    },
    {
      edge: edge,
      end: edge.target,
      key: `${edge.id}:target`,
      other: edge.source,
      slot: `target:${edge.id}`,
    },
  ]);
  const fans = new Map<string, number>();
  for (const group of groupBy(
    ends,
    (item) => `${item.end.nodeId}:${item.end.side}`,
  )) {
    const sorted = [...group].sort(
      (a, b) => a.other.box.y - b.other.box.y || a.key.localeCompare(b.key),
    );
    const length = Math.min(group[0].end.box.height, SIDE_HANDLE_TOP * 2);
    let slots = groupBy(sorted, (item) => item.slot);
    const room = Math.max(length - SIDE_FAN_INSET * 2, 0);
    if (slots.length > 1 && room / (slots.length - 1) <= LANE_SPACING) {
      slots = groupBy(sorted, (item) => `kind:${item.edge.kind}`);
    }
    fanOffsets(slots.length, length, SIDE_FAN_INSET, SIDE_FAN_SPACING).forEach(
      (offset, index) => {
        for (const item of slots[index]) fans.set(item.key, offset);
        union(slots[index].map((item) => item.edge.id));
      },
    );
  }

  return {
    fans: fans,
    owners: new Map(sideEdges.map((edge) => [edge.id, find(edge.id)])),
  };
}

/** {@link findLane}, and record the run it takes. */
function takeLane(
  runs: Runs,
  owner: string,
  base: number,
  direction: -1 | 0 | 1,
  from: number,
  to: number,
  spacing: number,
): number {
  const at = findLane(runs, owner, base, direction, from, to, spacing);
  addRun(runs, { at: at, from: from, owner: owner, to: to });

  return at;
}
