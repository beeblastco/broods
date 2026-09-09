import { describe, expect, it } from "vitest";
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  findFreePosition,
  GRID,
  NODE_HEIGHT,
  NODE_WIDTH,
  tidyCanvasLayout,
  type LayoutEdge,
  type LayoutNode,
} from "../model/canvasLayout";

function node(id: string, type: string, label: string): LayoutNode {
  return { id: id, type: type, data: { label: label } };
}

function edge(source: string, target: string, kind?: string): LayoutEdge {
  return {
    id: kind
      ? `${kind}:${source}-x-${target}-y`
      : `xy-edge__${source}-${target}`,
    source: source,
    target: target,
  };
}

/** Every pair of laid-out cards must be clear of every other. */
function overlappingPairs(
  positions: Map<string, { x: number; y: number }>,
): string[] {
  const entries = [...positions.entries()];
  const clashes: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      if (
        Math.abs(a.x - b.x) < NODE_WIDTH &&
        Math.abs(a.y - b.y) < NODE_HEIGHT
      ) {
        clashes.push(`${idA}/${idB}`);
      }
    }
  }

  return clashes;
}

describe("tidyCanvasLayout", () => {
  const nodes = [
    node("a1", "agent", "support"),
    node("a2", "agent", "triage"),
    node("d1", "database", "session"),
    node("m1", "mcp", "linear"),
    node("s1", "sandbox", "py-sbx"),
    node("s2", "sandbox", "node-sbx"),
    node("w1", "workspace", "shared-docs"),
    node("k1", "skill", "pdf-parse"),
    node("x1", "mcp", "unwired"),
  ];
  const edges = [
    edge("a1", "d1"),
    edge("a1", "m1"),
    edge("a1", "s1"),
    edge("a1", "w1"),
    edge("a2", "w1"),
    edge("a2", "s2"),
    edge("a2", "k1"),
    edge("s1", "w1", "mount"),
    edge("a1", "a2", "subagent"),
  ];
  // The layout is pure, so one run covers every assertion below.
  const positions = tidyCanvasLayout(nodes, edges);

  it("places every node exactly once, with no card overlapping another", () => {
    expect([...positions.keys()].sort()).toEqual(nodes.map((n) => n.id).sort());
    expect(overlappingPairs(positions)).toEqual([]);
  });

  it("puts agents on the top row above their own services", () => {
    expect(positions.get("a1")?.y).toBe(0);
    expect(positions.get("a2")?.y).toBe(0);
    for (const id of ["d1", "m1", "s1", "s2", "k1"]) {
      expect(positions.get(id)!.y).toBeGreaterThan(NODE_HEIGHT);
    }
  });

  it("orders an agent's services into typed columns", () => {
    // database, sandbox, mcp for `support`: the session column sits left of the
    // sandbox column, which sits left of the mcp column.
    expect(positions.get("d1")!.x).toBeLessThan(positions.get("s1")!.x);
    expect(positions.get("s1")!.x).toBeLessThan(positions.get("m1")!.x);
  });

  it("drops a shared service below both clusters, and an unwired one lower still", () => {
    const clusterBottom = Math.max(
      positions.get("s1")!.y,
      positions.get("s2")!.y,
      positions.get("k1")!.y,
    );

    expect(positions.get("w1")!.y).toBeGreaterThan(clusterBottom);
    expect(positions.get("x1")!.y).toBeGreaterThan(positions.get("w1")!.y);
  });

  it("keeps a sub-agent next to its parent", () => {
    // `triage` sorts after `support` by label anyway, so assert the sub-agent
    // link survives a reversed label order too.
    const reversed = tidyCanvasLayout(
      [
        node("a1", "agent", "zulu"),
        node("a2", "agent", "alpha"),
        node("s1", "sandbox", "py-sbx"),
      ],
      [edge("a1", "s1"), edge("a1", "a2", "subagent")],
    );

    expect(positions.get("a1")!.x).toBeLessThan(positions.get("a2")!.x);
    expect(reversed.get("a1")!.x).toBeLessThan(reversed.get("a2")!.x);
  });

  it("is deterministic and puts every card on a whole cell", () => {
    const second = tidyCanvasLayout([...nodes].reverse(), [...edges].reverse());

    expect(CELL_WIDTH % GRID).toBe(0);
    expect(CELL_HEIGHT % GRID).toBe(0);
    for (const [id, position] of positions) {
      expect(second.get(id)).toEqual(position);
      expect(position.x % CELL_WIDTH).toBe(0);
      expect(position.y % CELL_HEIGHT).toBe(0);
    }
  });

  it("survives a sub-agent cycle without dropping an agent", () => {
    const positions = tidyCanvasLayout(
      [node("a1", "agent", "one"), node("a2", "agent", "two")],
      [edge("a1", "a2", "subagent"), edge("a2", "a1", "subagent")],
    );

    expect(positions.size).toBe(2);
  });
});

describe("findFreePosition", () => {
  it("keeps the requested spot when nothing is in the way", () => {
    const cell = { x: CELL_WIDTH, y: CELL_HEIGHT };

    expect(findFreePosition(cell, [])).toEqual(cell);
  });

  it("snaps the requested spot to the nearest cell", () => {
    expect(findFreePosition({ x: CELL_WIDTH + 30, y: 50 }, [])).toEqual({
      x: CELL_WIDTH,
      y: 0,
    });
  });

  it("steps to a neighbouring cell when the spot is taken", () => {
    const occupied = [{ x: CELL_WIDTH, y: CELL_HEIGHT }];
    const placed = findFreePosition(
      { x: CELL_WIDTH + 4, y: CELL_HEIGHT + 2 },
      occupied,
    );

    expect(placed).not.toEqual(occupied[0]);
    expect(placed.x % CELL_WIDTH).toBe(0);
    expect(placed.y % CELL_HEIGHT).toBe(0);
    expect(
      Math.abs(placed.x - CELL_WIDTH) + Math.abs(placed.y - CELL_HEIGHT),
    ).toBeLessThanOrEqual(CELL_WIDTH + CELL_HEIGHT);
  });

  it("treats a legacy off-cell card as filling every cell it reaches into", () => {
    // A card straddling the first two cells of the top row blocks both of them.
    const occupied = [{ x: CELL_WIDTH / 2, y: 0 }];

    expect(findFreePosition({ x: 0, y: 0 }, occupied).y).not.toBe(0);
    expect(findFreePosition({ x: CELL_WIDTH, y: 0 }, occupied).y).not.toBe(0);
  });
});
