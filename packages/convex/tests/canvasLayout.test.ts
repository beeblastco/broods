import { describe, expect, it } from "vitest";
import {
  agentEdgePoints,
  crossedBoxIds,
  handlePoint,
  routeCanvasEdges,
} from "../model/canvasEdgeRoutes";
import {
  deriveCanvasGroups,
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  type McpServersByNode,
} from "../model/canvasFrames";
import {
  cardHeight,
  findFreePosition,
  GRID,
  NODE_HEIGHT,
  NODE_WIDTH,
  SERVICE_TOP,
  tidyCanvasLayout,
  type LayoutEdge,
  type LayoutNode,
  type LayoutPosition,
  type LayoutRect,
} from "../model/canvasLayout";

const NO_SERVERS: McpServersByNode = new Map();

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
  for (const frame of framesOf(deriveCanvasGroups(nodes, edges, NO_SERVERS))) {
    const origin = frameOriginOf(
      frame.memberIds.map((id) => positions.get(id)!),
    );
    boxes.set(frame.id, { ...origin, ...frameSize(frame) });
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
  const positions = tidyCanvasLayout(nodes, edges, NO_SERVERS);

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
    // database, mcp, sandbox for `support`: the session column sits left of the
    // mcp column, which sits next to the sandbox column its runs-on edge reaches.
    expect(positions.get("d1")!.x).toBeLessThan(positions.get("m1")!.x);
    expect(positions.get("m1")!.x).toBeLessThan(positions.get("s1")!.x);
  });

  it("puts a shared service in the row between its agents, and an unwired one below", () => {
    expect(positions.get("w1")!.x).toBeGreaterThan(positions.get("s1")!.x);
    expect(positions.get("w1")!.x).toBeLessThan(positions.get("s2")!.x);
    expect(positions.get("w1")!.y).toBe(positions.get("s1")!.y);
    expect(positions.get("x1")!.y).toBeGreaterThan(
      positions.get("w1")!.y + NODE_HEIGHT,
    );
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
      NO_SERVERS,
    );

    expect(positions.get("a1")!.x).toBeLessThan(positions.get("a2")!.x);
    expect(reversed.get("a1")!.x).toBeLessThan(reversed.get("a2")!.x);
  });

  it("is deterministic and puts every frame and lone card on the dot grid", () => {
    const second = tidyCanvasLayout(
      [...nodes].reverse(),
      [...edges].reverse(),
      NO_SERVERS,
    );

    for (const [id, position] of positions) {
      expect(second.get(id)).toEqual(position);
    }
    for (const box of boardBoxes(nodes, edges, positions).values()) {
      expect(box.x % GRID).toBe(0);
      expect(box.y % GRID).toBe(0);
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
    const laid = tidyCanvasLayout(threeSandboxes, wiring, NO_SERVERS);

    const frames = framesOf(
      deriveCanvasGroups(threeSandboxes, wiring, NO_SERVERS),
    );
    expect(frames).toHaveLength(1);
    for (const frame of frames) {
      const members = frame.memberIds.map((id) => laid.get(id)!);
      const slots = frameMemberPositions(frameOriginOf(members), frame);

      expect(members).toEqual([...slots.values()]);
    }
    expect(overlappingPairs(boardBoxes(threeSandboxes, wiring, laid))).toEqual(
      [],
    );
  });

  it("puts the sandbox a workspace mounts next to the workspaces, whatever runs where", () => {
    const layout = (
      mountOn: string,
      order: string[],
    ): Map<string, LayoutPosition> =>
      tidyCanvasLayout(
        [
          node("a1", "agent", "support", { sandboxOrder: order }),
          node("cloud", "sandbox", "cloud"),
          node("mac", "sandbox", "mac", { config: { provider: "machine" } }),
          node("w1", "workspace", "notes"),
        ],
        [
          edge("a1", "cloud"),
          edge("a1", "mac"),
          edge("a1", "w1"),
          edge("w1", mountOn, "mount"),
        ],
        NO_SERVERS,
      );

    for (const [mountOn, other] of [
      ["mac", "cloud"],
      ["cloud", "mac"],
    ]) {
      for (const order of [
        ["mac", "cloud"],
        ["cloud", "mac"],
      ]) {
        const laid = layout(mountOn, order);
        expect(laid.get(mountOn)!.x, `${mountOn} ${order}`).toBeGreaterThan(
          laid.get(other)!.x,
        );
        expect(laid.get("w1")!.x).toBeGreaterThan(laid.get(mountOn)!.x);
      }
    }
  });

  it("puts a machine MCP server next to the computer it runs on", () => {
    const laid = tidyCanvasLayout(
      [
        node("a1", "agent", "support"),
        node("cloud", "sandbox", "cloud"),
        node("mac", "sandbox", "mac", { config: { provider: "machine" } }),
        node("tool", "mcp", "tool"),
        node("api", "mcp", "api"),
        node("w1", "workspace", "notes"),
      ],
      [
        edge("a1", "cloud"),
        edge("a1", "mac"),
        edge("a1", "tool"),
        edge("a1", "api"),
        edge("a1", "w1"),
        edge("w1", "cloud", "mount"),
      ],
      new Map([
        ["tool", { sandbox: "mac", transport: "machine" }],
        ["api", { sandbox: null, transport: "http" }],
      ]),
    );
    const order = ["api", "tool", "mac", "cloud", "w1"].map(
      (id) => laid.get(id)!.x,
    );

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts a service several agents share after the middle one of them", () => {
    const laid = tidyCanvasLayout(
      [
        node("a", "agent", "alpha"),
        node("b", "agent", "bravo"),
        node("c", "agent", "charlie"),
        node("sa", "sandbox", "alpha-box"),
        node("sb", "sandbox", "bravo-box"),
        node("sc", "sandbox", "charlie-box"),
        node("wiki", "workspace", "wiki"),
      ],
      [
        edge("a", "sa"),
        edge("b", "sb"),
        edge("c", "sc"),
        edge("a", "wiki"),
        edge("b", "wiki"),
        edge("c", "wiki"),
      ],
      NO_SERVERS,
    );

    expect(laid.get("wiki")!.x).toBeGreaterThan(laid.get("sb")!.x);
    expect(laid.get("wiki")!.x).toBeLessThan(laid.get("sc")!.x);
  });

  it("stacks cards at the height their rows draw at", () => {
    // Unwired workspaces park in one column; a long name wraps and the state
    // line adds a row, so each card is taller than the minimum.
    const long = "a-workspace-name-that-wraps";
    const laid = tidyCanvasLayout(
      [node("w1", "workspace", long), node("w2", "workspace", `${long}-too`)],
      [],
      NO_SERVERS,
    );
    const height = cardHeight(long, {
      features: 0,
      refCount: 0,
      stateText: "read-only",
      subtitle: false,
    });

    expect(height).toBeGreaterThan(NODE_HEIGHT);
    expect(laid.get("w2")!.y - laid.get("w1")!.y).toBeGreaterThanOrEqual(
      height + 48,
    );
  });

  it("keeps a mounted pair together: beside its agent, or in the shared block", () => {
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
      NO_SERVERS,
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
      NO_SERVERS,
    );

    // Both sandboxes share tracy's cloud frame in the first column; the one
    // tracy lists comes first, the mounted one takes the next slot. The lone
    // workspace is a card in the next column, level with the frame.
    const frameTop = cluster.get("s2")!.y - FRAME_HEADER_HEIGHT;
    expect(cluster.get("s2")!.x).toBe(FRAME_PADDING);
    expect(frameTop).toBeGreaterThanOrEqual(SERVICE_TOP);
    expect(cluster.get("s1")!.x).toBe(FRAME_PADDING);
    expect(cluster.get("s1")!.y).toBeGreaterThan(cluster.get("s2")!.y);
    expect(cluster.get("w1")!.y).toBe(frameTop);
    expect(cluster.get("w1")!.x).toBeGreaterThan(cluster.get("s2")!.x);
    expect(shared.get("s1")!.y).toBe(shared.get("w1")!.y);
    expect(shared.get("s1")!.y).toBeGreaterThanOrEqual(SERVICE_TOP);
    expect(shared.get("w1")!.x - shared.get("s1")!.x).toBeGreaterThan(
      NODE_WIDTH,
    );
  });

  it("keeps a group of one as a card on its cell", () => {
    const laid = tidyCanvasLayout(
      [node("a1", "agent", "tracy"), node("s1", "sandbox", "internal")],
      [edge("a1", "s1")],
      NO_SERVERS,
    );

    expect(laid.get("s1")!.x).toBe(0);
    expect(laid.get("s1")!.y % GRID).toBe(0);
  });

  it("leaves room for every lane: under the agent and in the gutters", () => {
    // Seven edges out of one agent, two frames stacked under it and a
    // service deep in a column, so buses pile up and gutters carry lanes.
    const many = [
      node("a1", "agent", "tracy"),
      node("d1", "database", "session"),
      node("m1", "mcp", "github"),
      node("m2", "mcp", "linear"),
      node("s1", "sandbox", "cloud-a"),
      node("s2", "sandbox", "cloud-b"),
      node("s3", "sandbox", "mac-a", { config: { provider: "machine" } }),
      node("s4", "sandbox", "mac-b", { config: { provider: "machine" } }),
      node("w1", "workspace", "notes"),
      node("w2", "workspace", "repos"),
      node("k1", "skill", "pdf"),
    ];
    const wiring = [
      ...["d1", "m1", "m2", "s1", "s2", "s3", "s4", "w1", "w2", "k1"].map(
        (id) => edge("a1", id),
      ),
      edge("w1", "s1", "mount"),
    ];
    const laid = tidyCanvasLayout(many, wiring, NO_SERVERS);
    const boxes = boardBoxes(many, wiring, laid);
    const agentEdges = [...boxes.keys()]
      .filter((id) => id !== "a1")
      .map((id) => ({ id: id, source: "a1", target: id }));
    const routes = routeCanvasEdges(boxes, agentEdges, []);

    expect(overlappingPairs(boxes)).toEqual([]);
    expect(routes.agent.size).toBe(agentEdges.length);
    // One row under the agent, so every edge is a straight drop off the bus.
    expect(
      [...routes.agent.values()].filter((route) => route.gutter !== null),
    ).toEqual([]);
    for (const [id, route] of routes.agent) {
      const points = agentEdgePoints(
        handlePoint(boxes.get("a1")!, "bottom"),
        handlePoint(boxes.get(id)!, "top"),
        route,
      );
      // Every segment stays out of every box but the two the edge joins.
      expect(crossedBoxIds(points, boxes, new Set(["a1", id])), id).toEqual([]);
    }
  });

  it("grows the gap under the agents until every bus fits", () => {
    // Three agents reach one service after the middle one, so all three buses
    // cross the same stretch and need three lanes.
    const agents = ["a", "b", "c"];
    const laid = tidyCanvasLayout(
      [
        ...agents.map((id) => node(id, "agent", id)),
        ...agents.map((id) => node(`k${id}`, "skill", `${id}-skill`)),
        node("wiki", "workspace", "wiki"),
      ],
      [
        ...agents.map((id) => edge(id, `k${id}`)),
        ...agents.map((id) => edge(id, "wiki")),
      ],
      NO_SERVERS,
    );

    expect(laid.get("wiki")!.y).toBeGreaterThan(SERVICE_TOP);
  });

  it("routes deep stacked cards down gutters that cross no box", () => {
    const skills = ["k1", "k2", "k3"];
    const nodes = [
      node("a1", "agent", "support"),
      node("d1", "database", "session"),
      ...skills.map((id) => node(id, "skill", id)),
    ];
    const edges = [edge("a1", "d1"), ...skills.map((id) => edge("a1", id))];
    const laid = tidyCanvasLayout(nodes, edges, NO_SERVERS);
    const boxes = boardBoxes(nodes, edges, laid);
    const routes = routeCanvasEdges(
      boxes,
      [...boxes.keys()]
        .filter((id) => id !== "a1")
        .map((id) => ({ id: id, source: "a1", target: id })),
      [],
    );

    expect(
      [...routes.agent.values()].filter((route) => route.gutter !== null),
    ).toHaveLength(2);
    for (const [id, route] of routes.agent) {
      const points = agentEdgePoints(
        handlePoint(boxes.get("a1")!, "bottom"),
        handlePoint(boxes.get(id)!, "top"),
        route,
      );
      expect(crossedBoxIds(points, boxes, new Set(["a1", id])), id).toEqual([]);
    }
  });

  it("survives a sub-agent cycle without dropping an agent", () => {
    const positions = tidyCanvasLayout(
      [node("a1", "agent", "one"), node("a2", "agent", "two")],
      [edge("a1", "a2", "subagent"), edge("a2", "a1", "subagent")],
      NO_SERVERS,
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
    const frame = {
      x: 240,
      y: 96,
      ...frameSize({ kind: "sandbox", memberIds: ["s1", "s2", "s3", "s4"] }),
    };
    const placed = findFreePosition({ x: 240, y: 240 }, [frame]);

    // Below the frame: a card-sized check at the origin alone would allow y 240.
    expect(placed.y).toBeGreaterThanOrEqual(frame.y + frame.height);
  });
});
