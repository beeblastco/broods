import { describe, expect, it } from "vitest";
import {
  agentEdgePoints,
  crossedBoxIds,
  handlePoint,
  LANE_SPACING,
  routeCanvasEdges,
  sideEdgePoints,
  type SideEdgeRequest,
} from "../model/canvasEdgeRoutes";
import type { LayoutRect } from "../model/canvasLayout";

/** An agent over two stacked cards in the column to its right. */
const BOXES = new Map<string, LayoutRect>([
  ["agent", box(0, 0)],
  ["top", box(240, 144)],
  ["deep", box(240, 432)],
  ["deeper", box(240, 720)],
]);

describe("routeCanvasEdges", () => {
  it("drops straight into a target with nothing in between, bottom to top", () => {
    const { agent } = routeCanvasEdges(
      BOXES,
      [{ id: "e", source: "agent", target: "top" }],
      [],
    );
    const route = agent.get("e")!;
    const points = agentEdgePoints(
      handlePoint(BOXES.get("agent")!, "bottom"),
      handlePoint(BOXES.get("top")!, "top"),
      route,
    );

    expect(route.gutter).toBeNull();
    expect(points[0]).toEqual({ x: 88, y: 96 });
    expect(points.at(-1)).toEqual({ x: 328, y: 144 });
    // Every run is vertical or horizontal.
    for (let index = 1; index < points.length; index++) {
      const [a, b] = [points[index - 1], points[index]];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it("drops straight past a frame beside the route, not through it", () => {
    // The sandbox frame stands in the rectangle between the two handles but
    // under the bus and left of the drop, so the edge keeps its two corners.
    const boxes = new Map<string, LayoutRect>([
      ["agent", box(0, 0)],
      ["frame", { height: 230, width: 280, x: 0, y: 200 }],
      ["workspaces", box(480, 288)],
    ]);
    const { agent } = routeCanvasEdges(
      boxes,
      [{ id: "e", source: "agent", target: "workspaces" }],
      [],
    );
    const points = agentEdgePoints(
      handlePoint(boxes.get("agent")!, "bottom"),
      handlePoint(boxes.get("workspaces")!, "top"),
      agent.get("e")!,
    );

    expect(agent.get("e")!.gutter).toBeNull();
    expect(
      crossedBoxIds(points, boxes, new Set(["agent", "workspaces"])),
    ).toEqual([]);
  });

  it("runs one agent's edges on one trunk, and takes the gutter past a card in the way", () => {
    const { agent } = routeCanvasEdges(
      BOXES,
      [
        { id: "top", source: "agent", target: "top" },
        { id: "deep", source: "agent", target: "deep" },
        { id: "deeper", source: "agent", target: "deeper" },
      ],
      [],
    );

    expect(agent.get("top")!.gutter).toBeNull();
    // Left of the column, one lane the two deep edges branch off.
    expect(agent.get("deep")!.gutter?.x).toBe(232);
    expect(agent.get("deeper")!.gutter?.x).toBe(232);
    expect(
      new Set([...agent.values()].map((route) => route.busDrop)).size,
    ).toBe(1);
  });

  it("keeps two agents' buses and gutter lanes apart", () => {
    const boxes = new Map([...BOXES, ["other", box(-240, 0)]]);
    const { agent } = routeCanvasEdges(
      boxes,
      [
        { id: "mine", source: "agent", target: "deep" },
        { id: "theirs", source: "other", target: "deeper" },
      ],
      [],
    );
    const mine = agent.get("mine")!;
    const theirs = agent.get("theirs")!;

    expect(Math.abs(mine.busDrop - theirs.busDrop)).toBeGreaterThanOrEqual(
      LANE_SPACING,
    );
    expect(Math.abs(mine.gutter!.x - theirs.gutter!.x)).toBeGreaterThanOrEqual(
      LANE_SPACING,
    );
  });

  it("keeps two agents' buses clearly apart where their ends come close", () => {
    // Both agents reach one card between them, so their buses end a fan apart.
    const boxes = new Map([
      ["left", box(0, 0)],
      ["right", box(600, 0)],
      ["shared", box(300, 144)],
    ]);
    const { agent } = routeCanvasEdges(
      boxes,
      [
        { id: "l", source: "left", target: "shared" },
        { id: "r", source: "right", target: "shared" },
      ],
      [],
    );

    expect(
      Math.abs(agent.get("l")!.busDrop - agent.get("r")!.busDrop),
    ).toBeGreaterThanOrEqual(16);
  });

  it("keeps a side edge off a gutter lane it runs beside", () => {
    const boxes = new Map([...BOXES, ["left", box(48, 300)]]);
    const { agent, side } = routeCanvasEdges(
      boxes,
      [{ id: "deep", source: "agent", target: "deep" }],
      [sideEdge("mount", boxes, "left", "right", "deep", "left")],
    );
    const lane = agent.get("deep")!.gutter!.x;
    const route = side.get("mount")!;

    expect(route.underY).toBeNull();
    expect(Math.abs(route.sourceX - lane)).toBeGreaterThanOrEqual(LANE_SPACING);
  });

  it("steps straight between neighbours and detours under a box in the way", () => {
    const boxes = new Map([
      ["left", box(0, 144)],
      ["middle", box(240, 144)],
      ["right", box(480, 144)],
    ]);
    const near = sideEdge("near", boxes, "left", "right", "middle", "left");
    const far = sideEdge("far", boxes, "left", "right", "right", "left");
    const { side } = routeCanvasEdges(boxes, [], [near, far]);

    expect(side.get("near")!.underY).toBeNull();
    const detour = side.get("far")!;
    expect(detour.underY).toBeGreaterThan(240);
    const points = sideEdgePoints(
      handlePoint(far.source.box, "right"),
      handlePoint(far.target.box, "left"),
      detour,
    );
    expect(crossedBoxIds(points, boxes, new Set(["left", "right"]))).toEqual(
      [],
    );
  });

  it("fans two side edges into one handle so their last legs never share a run", () => {
    const boxes = new Map([
      ["one", box(0, 144)],
      ["two", box(0, 288)],
      ["computer", box(240, 200)],
    ]);
    const { side } = routeCanvasEdges(
      boxes,
      [],
      [
        sideEdge("a", boxes, "one", "right", "computer", "left"),
        sideEdge("b", boxes, "two", "right", "computer", "left"),
      ],
    );
    const fans = [side.get("a")!.targetFan, side.get("b")!.targetFan];

    expect(Math.abs(fans[0] - fans[1])).toBeGreaterThanOrEqual(LANE_SPACING);
  });
});

describe("side edge legs", () => {
  it("keep a lane apart where a mount and an inherited edge meet one handle", () => {
    // A sandbox chip left of two workspace chips, the upper inheriting it and
    // the lower mounted on it: the upper's lead-in must not run along the
    // lower's last leg.
    const boxes = new Map([
      ["sandbox", { height: 44, width: 184, x: 0, y: 0 }],
      ["upper", { height: 60, width: 184, x: 240, y: 0 }],
      ["lower", { height: 60, width: 184, x: 240, y: 68 }],
    ]);
    const edges = [
      sideEdge(
        "inherits:upper-sandbox",
        boxes,
        "upper",
        "left",
        "sandbox",
        "right",
      ),
      sideEdge(
        "mount:lower-left-sandbox-right",
        boxes,
        "lower",
        "left",
        "sandbox",
        "right",
      ),
    ];
    const { side } = routeCanvasEdges(boxes, [], edges);
    const [first, second] = edges.map((edge) =>
      sideEdgePoints(
        handlePoint(edge.source.box, edge.source.side),
        handlePoint(edge.target.box, edge.target.side),
        side.get(edge.id)!,
      ),
    );
    const runs = (points: { x: number; y: number }[]): number[][] =>
      points
        .slice(1)
        .flatMap((point, index) =>
          point.y === points[index].y
            ? [
                [
                  point.y,
                  Math.min(point.x, points[index].x),
                  Math.max(point.x, points[index].x),
                ],
              ]
            : [],
        );
    const touching = runs(first).flatMap(([y, from, to]) =>
      runs(second).filter(
        ([otherY, otherFrom, otherTo]) =>
          Math.abs(y - otherY) < LANE_SPACING &&
          from < otherTo &&
          otherFrom < to,
      ),
    );

    expect(touching).toEqual([]);
  });
});

describe("crowded handles", () => {
  it("merge edges of one kind into a trunk where a chip is too short to fan them", () => {
    // Five workspace chips inheriting one sandbox chip: 44px cannot hold five
    // ends a lane apart, so they share one end and one lane.
    const boxes = new Map([
      ["sandbox", { height: 44, width: 184, x: 0, y: 0 }],
      ...Array.from({ length: 5 }, (_, index): [string, LayoutRect] => [
        `w${index}`,
        { height: 60, width: 184, x: 240, y: index * 68 },
      ]),
    ]);
    const edges = Array.from({ length: 5 }, (_, index) =>
      sideEdge(
        `inherits:w${index}-sandbox`,
        boxes,
        `w${index}`,
        "left",
        "sandbox",
        "right",
      ),
    );
    const { side } = routeCanvasEdges(boxes, [], edges);
    const routes = edges.map((edge) => side.get(edge.id)!);

    expect(new Set(routes.map((route) => route.targetFan)).size).toBe(1);
    expect(routes.every((route) => route.underY === null)).toBe(true);
  });
});

describe("crossedBoxIds", () => {
  it("counts a segment through a box whose corners all sit outside it", () => {
    const boxes = new Map([["wide", box(100, 0)]]);
    const through = [
      { x: 0, y: 48 },
      { x: 400, y: 48 },
    ];
    const along = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
    ];

    expect(crossedBoxIds(through, boxes, new Set())).toEqual(["wide"]);
    expect(crossedBoxIds(along, boxes, new Set())).toEqual([]);
  });
});

function box(x: number, y: number): LayoutRect {
  return { height: 96, width: 176, x: x, y: y };
}

/** A side edge from one box's side handle to another's, each box its own top-level box. */
function sideEdge(
  id: string,
  boxes: ReadonlyMap<string, LayoutRect>,
  source: string,
  sourceSide: "left" | "right",
  target: string,
  targetSide: "left" | "right",
): SideEdgeRequest {
  return {
    id: id,
    kind: id.split(":")[0],
    source: {
      box: boxes.get(source)!,
      nodeId: source,
      outerId: source,
      side: sourceSide,
    },
    target: {
      box: boxes.get(target)!,
      nodeId: target,
      outerId: target,
      side: targetSide,
    },
  };
}
