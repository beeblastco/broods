import { describe, expect, it } from "vitest";
import {
  deriveCanvasFrames,
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  frameMemberPositions,
  frameOriginOf,
  frameSize,
  type McpTransportsByNode,
} from "../model/canvasFrames";
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
  type LayoutPosition,
  type LayoutRect,
} from "../model/canvasLayout";

const NO_TRANSPORTS: McpTransportsByNode = new Map();

function node(
  id: string,
  type: string,
  label: string,
  data: Record<string, unknown> = {},
): LayoutNode {
  return { id: id, type: type, data: { label: label, ...data } };
}

function card(position: LayoutPosition): LayoutRect {
  return { ...position, height: NODE_HEIGHT, width: NODE_WIDTH };
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

/** Every box on the board: one per frame, one per card no frame holds. */
function boardBoxes(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  positions: Map<string, LayoutPosition>,
): Map<string, LayoutRect> {
  const boxes = new Map<string, LayoutRect>();
  const framed = new Set<string>();
  for (const frame of deriveCanvasFrames(nodes, edges, NO_TRANSPORTS)) {
    const origin = frameOriginOf(
      frame.memberIds.map((id) => positions.get(id)!),
    );
    boxes.set(frame.id, { ...origin, ...frameSize(frame.memberIds.length) });
    for (const id of frame.memberIds) framed.add(id);
  }
  for (const [id, position] of positions) {
    if (framed.has(id)) continue;
    boxes.set(id, { ...position, height: NODE_HEIGHT, width: NODE_WIDTH });
  }

  return boxes;
}

/** Every pair of boxes on the board that intersect. */
function overlappingPairs(boxes: Map<string, LayoutRect>): string[] {
  const entries = [...boxes.entries()];
  const clashes: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
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
    edge("a1", "a2", "subagent"),
  ];
  // The layout is pure, so one run covers every assertion below.
  const positions = tidyCanvasLayout(nodes, edges, NO_TRANSPORTS);

  it("places every node exactly once, with no frame or card overlapping another", () => {
    expect([...positions.keys()].sort()).toEqual(nodes.map((n) => n.id).sort());
    expect(overlappingPairs(boardBoxes(nodes, edges, positions))).toEqual([]);
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
      NO_TRANSPORTS,
    );

    expect(positions.get("a1")!.x).toBeLessThan(positions.get("a2")!.x);
    expect(reversed.get("a1")!.x).toBeLessThan(reversed.get("a2")!.x);
  });

  it("is deterministic and puts every frame and lone card on a whole cell", () => {
    const second = tidyCanvasLayout(
      [...nodes].reverse(),
      [...edges].reverse(),
      NO_TRANSPORTS,
    );

    expect(CELL_WIDTH % GRID).toBe(0);
    expect(CELL_HEIGHT % GRID).toBe(0);
    for (const [id, position] of positions) {
      expect(second.get(id)).toEqual(position);
    }
    for (const box of boardBoxes(nodes, edges, positions).values()) {
      expect(box.x % CELL_WIDTH).toBe(0);
      expect(box.y % CELL_HEIGHT).toBe(0);
    }
  });

  it("fills each frame's slots in member order", () => {
    const threeSandboxes = [
      node("a1", "agent", "support"),
      node("s1", "sandbox", "alpha"),
      node("s2", "sandbox", "bravo"),
      node("s3", "sandbox", "charlie"),
      node("w1", "workspace", "docs"),
    ];
    const wiring = [
      edge("a1", "s1"),
      edge("a1", "s2"),
      edge("a1", "s3"),
      edge("a1", "w1"),
    ];
    const laid = tidyCanvasLayout(threeSandboxes, wiring, NO_TRANSPORTS);

    for (const frame of deriveCanvasFrames(
      threeSandboxes,
      wiring,
      NO_TRANSPORTS,
    )) {
      const members = frame.memberIds.map((id) => laid.get(id)!);
      const slots = frameMemberPositions(
        frameOriginOf(members),
        frame.memberIds,
      );

      expect(members).toEqual([...slots.values()]);
    }
    expect(overlappingPairs(boardBoxes(threeSandboxes, wiring, laid))).toEqual(
      [],
    );
  });

  it("stacks sandbox frames by their lowest order number", () => {
    const sandboxes = (order: string[]): LayoutNode[] => [
      node("a1", "agent", "support", { sandboxOrder: order }),
      node("cloud", "sandbox", "cloud"),
      node("mac", "sandbox", "mac", { config: { provider: "machine" } }),
    ];
    const wiring = [edge("a1", "cloud"), edge("a1", "mac")];
    const macFirst = tidyCanvasLayout(
      sandboxes(["mac", "cloud"]),
      wiring,
      NO_TRANSPORTS,
    );
    const cloudFirst = tidyCanvasLayout(
      sandboxes(["cloud", "mac"]),
      wiring,
      NO_TRANSPORTS,
    );

    expect(macFirst.get("mac")!.y).toBeLessThan(macFirst.get("cloud")!.y);
    expect(cloudFirst.get("cloud")!.y).toBeLessThan(cloudFirst.get("mac")!.y);
  });

  it("keeps a mounted pair together: beside its agent, or in the shared lane", () => {
    // `tracy` reaches `browser-sandbox` only through the workspace that mounts
    // it, so the sandbox belongs in tracy's cluster, not the unwired lane.
    const cluster = tidyCanvasLayout(
      [
        node("a1", "agent", "tracy"),
        node("s1", "sandbox", "browser-sandbox"),
        node("s2", "sandbox", "internal-sandbox"),
        node("w1", "workspace", "browser-workspace"),
      ],
      [edge("a1", "s2"), edge("a1", "w1"), edge("s1", "w1", "mount")],
      NO_TRANSPORTS,
    );
    // A sandbox mounted into a workspace two agents reach is reached by both,
    // so the pair drops to the shared lane side by side.
    const shared = tidyCanvasLayout(
      [
        node("a1", "agent", "support"),
        node("a2", "agent", "triage"),
        node("s1", "sandbox", "py-sbx"),
        node("w1", "workspace", "shared-docs"),
      ],
      [
        edge("a1", "s1"),
        edge("a1", "w1"),
        edge("a2", "w1"),
        edge("s1", "w1", "mount"),
      ],
      NO_TRANSPORTS,
    );

    // Both sandboxes share tracy's cloud frame in the first column; the one
    // tracy lists comes first, the mounted one takes the next slot.
    expect(cluster.get("s2")).toEqual({
      x: FRAME_PADDING,
      y: CELL_HEIGHT + FRAME_HEADER_HEIGHT,
    });
    expect(cluster.get("s1")!.x).toBe(FRAME_PADDING);
    expect(cluster.get("s1")!.y).toBeGreaterThan(cluster.get("s2")!.y);
    expect(cluster.get("w1")).toEqual({
      x: CELL_WIDTH + FRAME_PADDING,
      y: CELL_HEIGHT + FRAME_HEADER_HEIGHT,
    });
    expect(shared.get("s1")!.y).toBe(shared.get("w1")!.y);
    expect(shared.get("s1")!.y).toBeGreaterThan(CELL_HEIGHT);
    expect(shared.get("w1")!.x - shared.get("s1")!.x).toBe(CELL_WIDTH);
  });

  it("survives a sub-agent cycle without dropping an agent", () => {
    const positions = tidyCanvasLayout(
      [node("a1", "agent", "one"), node("a2", "agent", "two")],
      [edge("a1", "a2", "subagent"), edge("a2", "a1", "subagent")],
      NO_TRANSPORTS,
    );

    expect(positions.size).toBe(2);
  });
});

describe("findFreePosition", () => {
  it("keeps the requested spot when nothing is in the way", () => {
    expect(findFreePosition({ x: 240, y: 96 }, [])).toEqual({ x: 240, y: 96 });
  });

  it("snaps the requested spot to the nearest background dot", () => {
    expect(findFreePosition({ x: 251, y: 91 }, [])).toEqual({ x: 240, y: 96 });
  });

  it("steps down the dot grid to the first row that clears a taken spot", () => {
    const occupied = [card({ x: 240, y: 96 })];

    // Five 24px steps: the first offset past the card height plus margin.
    expect(findFreePosition({ x: 244, y: 98 }, occupied)).toEqual({
      x: 240,
      y: 216,
    });
  });

  it("keeps a margin from a card it would otherwise touch", () => {
    const taken = { x: 240, y: 96 };
    const placed = findFreePosition({ x: 240 + NODE_WIDTH, y: 96 }, [
      card(taken),
    ]);

    expect(placed.x % GRID).toBe(0);
    expect(placed.y % GRID).toBe(0);
    expect(
      Math.abs(placed.x - taken.x) > NODE_WIDTH ||
        Math.abs(placed.y - taken.y) > NODE_HEIGHT,
    ).toBe(true);
  });

  it("steps clear of a whole frame, not just its first card", () => {
    const frame = { x: 240, y: 96, ...frameSize(4) };
    const placed = findFreePosition({ x: 240, y: 240 }, [frame]);

    // Below the frame: a card-sized check at the origin alone would allow y 240.
    expect(placed.y).toBeGreaterThanOrEqual(frame.y + frame.height);
  });
});
