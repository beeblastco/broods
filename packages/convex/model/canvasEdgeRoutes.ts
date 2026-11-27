// Pure: the dashboard imports this router too, so no Convex server imports.

import type { LayoutPosition, LayoutRect } from "./canvasLayout";

// Arrowhead (9px) + corner radius (8px) + handle overhang, so the last run lies straight.
export const ARROW_RUN = 24;

const APPROACH_INSET = ARROW_RUN;

const BUS_END_GAP = 24;

export const BUS_INSET = 12;

const BUS_SPACING = 16;

const FAN_INSET = 16;

const GUTTER_INSET = ARROW_RUN;

export const LANE_SPACING = 8;

const SIDE_FAN_INSET = 8;

const SIDE_FAN_SPACING = 24;

// Card side handles sit at `top-12` in `BaseNode.tsx`; a shorter box has them at its middle.
const SIDE_HANDLE_TOP = 48;

const STEP_TRIES = 5;

const TARGET_FAN_SPACING = 16;

export type AgentEdgeRequest = { id: string; source: string; target: string };

// `busDrop`, `gutter.rise` and `targetFan` are relative to the handles, so they hold while a
// drag moves an end; `gutter.x` is absolute. A null gutter is a straight drop.
export type AgentEdgeRoute = {
  busDrop: number;
  gutter: { rise: number; x: number } | null;
  targetFan: number;
};

export type EdgeRoutes = {
  agent: Map<string, AgentEdgeRoute>;
  side: Map<string, SideEdgeRoute>;
};

export type HandleSide = "bottom" | "left" | "right" | "top";

export type SideEdgeRequest = {
  id: string;
  kind: string;
  source: SideEnd;
  target: SideEnd;
};

// With `underY` null the two xs are one run between facing handles.
export type SideEdgeRoute = {
  sourceFan: number;
  sourceX: number;
  targetFan: number;
  targetX: number;
  underY: number | null;
};

export type SideEnd = {
  box: LayoutRect;
  nodeId: string;
  outerId: string;
  side: "left" | "right";
};

type Leg = {
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

// `at` is the x of a vertical run or the y of a horizontal one.
type Run = { at: number; from: number; owner: string; to: number };

type Runs = Map<number, Run[]>;

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

export function facingSide(
  box: LayoutRect,
  other: LayoutRect,
): "left" | "right" {
  return other.x + other.width / 2 < box.x + box.width / 2 ? "left" : "right";
}

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

export function routeCanvasEdges(
  boxes: ReadonlyMap<string, LayoutRect>,
  agentEdges: readonly AgentEdgeRequest[],
  sideEdges: readonly SideEdgeRequest[],
): EdgeRoutes {
  const verticals: Runs = new Map();
  const horizontals: Runs = new Map();
  const legs = agentLegs(boxes, agentEdges);

  // Gutter lanes first, nearest target first, so a deeper one takes the outer lane.
  for (const leg of legs
    .filter((item) => item.blocked)
    .sort((a, b) => a.end.y - b.end.y || a.id.localeCompare(b.id))) {
    const side = leg.start.x <= leg.end.x ? "left" : "right";
    leg.gutterX = takeLane(
      verticals,
      leg.request.source,
      gutterBase(
        leg.target,
        side,
        boxes,
        leg.start.y,
        leg.end.y - APPROACH_INSET,
      ),
      directionOf(side),
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

function agentLegs(
  boxes: ReadonlyMap<string, LayoutRect>,
  agentEdges: readonly AgentEdgeRequest[],
): Leg[] {
  return agentEdges.flatMap((request): Leg[] => {
    const source = boxes.get(request.source);
    const target = boxes.get(request.target);
    if (!source || !target) return [];
    const start = handlePoint(source, "bottom");
    const end = handlePoint(target, "top");
    if (end.y - start.y < BUS_INSET + APPROACH_INSET) return [];
    // Only a box the straight route passes through earns a detour, not one merely
    // inside the rectangle between the handles.
    const straight = agentEdgePoints(start, end, {
      busDrop: BUS_INSET,
      gutter: null,
      targetFan: 0,
    });

    return [
      {
        blocked:
          crossedBoxIds(
            straight,
            boxes,
            new Set([request.source, request.target]),
          ).length > 0,
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

function alternatingOffset(step: number): number {
  return (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2);
}

function directionOf(side: SideEnd["side"]): -1 | 1 {
  return side === "right" ? 1 : -1;
}

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
    const offset = direction === 0 ? alternatingOffset(step) : direction * step;
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

// A side edge's run ends under boxes not placed yet, so it leaves `to` open.
function gutterBase(
  box: LayoutRect,
  side: SideEnd["side"],
  boxes: ReadonlyMap<string, LayoutRect>,
  from: number,
  to = Infinity,
): number {
  const edge = side === "right" ? box.x + box.width : box.x;
  const direction = directionOf(side);
  const clear = (x: number): boolean =>
    ![...boxes.values()].some((other) =>
      segmentCrosses({ x: x, y: from }, { x: x, y: to }, other),
    );
  const full = edge + direction * GUTTER_INSET;
  if (clear(full)) return full;

  let gap = Infinity;
  for (const other of boxes.values()) {
    if (other.y >= to || other.y + other.height <= from) continue;
    const distance =
      side === "right" ? other.x - edge : edge - (other.x + other.width);
    if (distance > 0) gap = Math.min(gap, distance);
  }
  const middle = edge + (direction * gap) / 2;

  return gap < Infinity && clear(middle) ? middle : full;
}

function overlaps(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

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
    // A lane past each end, so two steps meeting end to end do not read as one jogged line.
    const top = Math.min(start.y, end.y) - LANE_SPACING;
    const bottom = Math.max(start.y, end.y) + LANE_SPACING;
    const middle = Math.round((start.x + end.x) / 2);
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
      const x = middle + alternatingOffset(step) * LANE_SPACING;
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
  const sourceBase = gutterBase(sourceOuter, edge.source.side, boxes, start.y);
  const targetBase = gutterBase(targetOuter, edge.target.side, boxes, end.y);
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

function runsClear(runs: Runs, candidates: readonly Run[]): boolean {
  return candidates.every((candidate) =>
    runClear(runs, candidate, LANE_SPACING),
  );
}

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

// Where a handle is too short to keep its slots a lane apart, edges of one kind share a slot
// and an owner: a trunk rather than lines run together.
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
