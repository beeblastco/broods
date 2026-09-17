import { describe, expect, it } from "vitest";
import {
  agentEdgePoints,
  handlePoint,
  LANE_SPACING,
  routeCanvasEdges,
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

  it("keeps a side edge off a gutter lane it runs beside", () => {
    const { agent, side } = routeCanvasEdges(
      BOXES,
      [{ id: "deep", source: "agent", target: "deep" }],
      [{ id: "mount", source: { x: 176, y: 200 }, target: { x: 288, y: 400 } }],
    );
    const lane = agent.get("deep")!.gutter!.x;

    expect(Math.abs(side.get("mount")!.centerX - lane)).toBeGreaterThanOrEqual(
      LANE_SPACING,
    );
  });
});

function box(x: number, y: number): LayoutRect {
  return { height: 96, width: 176, x: x, y: y };
}
