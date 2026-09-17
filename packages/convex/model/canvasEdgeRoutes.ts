/**
 * Lanes for the edges the canvas draws, shared by the dashboard, which draws
 * them, and the tidy layout, which leaves room for them.
 *
 * An agent edge leaves the agent's bottom and enters its target's top. With
 * nothing between the two it drops to a bus under the agent, runs across and
 * drops in. Otherwise it runs along the bus to the gutter beside the target,
 * down the gutter to the gap above the target, across and down into its top.
 * A side edge (mount, runs-on, inherited sandbox) is a step path whose
 * vertical run sits in the gap between its two ends.
 *
 * One agent's edges share a trunk and branch off it, like an org chart. Every
 * other run gets its own lane, at least LANE_SPACING from any parallel run of
 * another agent or side edge it shares a stretch with, so no two edges draw
 * over each other.
 *
 * Pure on purpose: the dashboard imports it, so no Convex server imports.
 */

import type { LayoutPosition, LayoutRect } from "./canvasLayout";

/** Distance between two parallel runs. */
export const LANE_SPACING = 8;

/** Below an agent's bottom, the first bus lane. */
export const BUS_INSET = 12;

/** Above a target's top, the first approach lane. */
const APPROACH_INSET = 12;

/** Kept clear at both ends of a box side that several edges fan across. */
const FAN_INSET = 16;

/** Between a box's side and the gutter lane nearest it. */
const GUTTER_INSET = 8;

/** How far apart edges entering one target's top spread at most. */
const TARGET_FAN_SPACING = 16;

/** An agent edge's lanes, relative to its handles where a drag moves them together. */
export type AgentEdgeRoute = {
  /** From the agent's bottom down to this edge's bus lane. */
  busDrop: number;
  /** The gutter lane, and how far above the target the approach lane runs; null for a straight drop. */
  gutter: { rise: number; x: number } | null;
  /** Along the target's top, from its centre. */
  targetFan: number;
};

/** An agent edge between two boxes on the board, by box id. */
export type AgentEdgeRequest = { id: string; source: string; target: string };

export type EdgeRoutes = {
  agent: Map<string, AgentEdgeRoute>;
  side: Map<string, SideEdgeRoute>;
};

export type HandleSide = "bottom" | "left" | "right" | "top";

/** A side edge by its two handle points. */
export type SideEdgeRequest = {
  id: string;
  source: LayoutPosition;
  target: LayoutPosition;
};

export type SideEdgeRoute = { centerX: number };

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

/** The corner points of an agent edge, from the agent's bottom handle to the target's top handle. */
export function agentEdgePoints(
  source: LayoutPosition,
  target: LayoutPosition,
  route: AgentEdgeRoute,
): LayoutPosition[] {
  const start = source;
  const end = { x: target.x + route.targetFan, y: target.y };
  const busY = source.y + route.busDrop;
  if (!route.gutter) {
    return [start, { x: start.x, y: busY }, { x: end.x, y: busY }, end];
  }
  const approachY = target.y - route.gutter.rise;

  return [
    start,
    { x: start.x, y: busY },
    { x: route.gutter.x, y: busY },
    { x: route.gutter.x, y: approachY },
    { x: end.x, y: approachY },
    end,
  ];
}

/** The side of `box` that faces `other`, left or right. */
export function facingSide(box: LayoutRect, other: LayoutRect): HandleSide {
  return other.x + other.width / 2 < box.x + box.width / 2 ? "left" : "right";
}

/** Centre of one side of a box, where React Flow puts that handle. */
export function handlePoint(box: LayoutRect, side: HandleSide): LayoutPosition {
  if (side === "top") return { x: box.x + box.width / 2, y: box.y };
  if (side === "bottom") {
    return { x: box.x + box.width / 2, y: box.y + box.height };
  }

  return {
    x: side === "left" ? box.x : box.x + box.width,
    y: box.y + box.height / 2,
  };
}

/**
 * Lanes for every agent and side edge. `boxes` holds every top-level box on
 * the board (agents, cards, frames); an agent edge runs between two of them
 * and steps around the rest. An agent's edges share one trunk: one drop, one
 * bus, and one lane per gutter, branching off where each one turns. Runs of
 * different agents, and of side edges, keep apart. Gutter lanes go first,
 * nearest target first, so a deeper one takes the outer lane.
 */
export function routeCanvasEdges(
  boxes: ReadonlyMap<string, LayoutRect>,
  agentEdges: readonly AgentEdgeRequest[],
  sideEdges: readonly SideEdgeRequest[],
): EdgeRoutes {
  const verticals: Run[] = [];
  const horizontals: Run[] = [];
  const legs = agentEdges.flatMap((request): Leg[] => {
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
        blocked: [...boxes].some(
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
    );
  }

  const side = new Map(
    [...sideEdges]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((edge): [string, SideEdgeRoute] => [
        edge.id,
        {
          centerX: takeLane(
            verticals,
            edge.id,
            Math.round((edge.source.x + edge.target.x) / 2),
            0,
            Math.min(edge.source.y, edge.target.y),
            Math.max(edge.source.y, edge.target.y),
          ),
        },
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
    fanOffsets(group, group[0].target.width).forEach((offset, index) => {
      group[index].targetFan = offset;
    });
  }

  // One bus per agent, spanning every turn it makes; the widest bus takes the
  // shallowest lane.
  const buses = groupBy(legs, (leg) => leg.request.source)
    .map((group) => {
      const turns = group.flatMap((leg) => [
        leg.start.x,
        leg.gutterX ?? leg.end.x + leg.targetFan,
      ]);

      return {
        from: Math.min(...turns) - LANE_SPACING,
        group: group,
        to: Math.max(...turns) + LANE_SPACING,
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
    );
    for (const leg of bus.group) leg.busY = busY;
  }

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

/**
 * Offsets that spread a group of edges across a box side of `width`, centred,
 * TARGET_FAN_SPACING apart, or closer when the side is too short for that.
 */
function fanOffsets(group: readonly Leg[], width: number): number[] {
  const room = Math.max(width - FAN_INSET * 2, 0);
  const step =
    group.length < 2
      ? 0
      : Math.min(TARGET_FAN_SPACING, room / (group.length - 1));

  return group.map((_, index) => (index - (group.length - 1) / 2) * step);
}

function groupBy(legs: readonly Leg[], key: (leg: Leg) => string): Leg[][] {
  const groups = new Map<string, Leg[]>();
  for (const leg of legs) {
    const group = groups.get(key(leg));
    if (group) group.push(leg);
    else groups.set(key(leg), [leg]);
  }

  return [...groups.values()];
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
 * The first lane from `base` that keeps LANE_SPACING from every run of
 * another owner it shares a stretch with, stepping one way (`direction` ±1)
 * or alternating around `base` (0). Runs of one owner may share a lane: that
 * is an agent's trunk. Records the run it takes.
 */
function takeLane(
  runs: Run[],
  owner: string,
  base: number,
  direction: -1 | 0 | 1,
  from: number,
  to: number,
): number {
  for (let step = 0; ; step++) {
    // Alternating: 0, +1, -1, +2, -2 lanes.
    const offset =
      direction === 0
        ? (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2)
        : direction * step;
    const at = base + offset * LANE_SPACING;
    const clear = runs.every(
      (run) =>
        run.owner === owner ||
        Math.abs(run.at - at) >= LANE_SPACING ||
        run.to <= from ||
        to <= run.from,
    );
    if (clear) {
      runs.push({ at: at, from: from, owner: owner, to: to });

      return at;
    }
  }
}
