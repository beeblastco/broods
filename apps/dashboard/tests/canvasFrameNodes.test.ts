import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  agentEdgePoints,
  crossedBoxIds,
  handlePoint,
  sideEdgePoints,
  type AgentEdgeRoute,
  type SideEdgeRoute,
} from "@broods/convex/model/canvasEdgeRoutes";
import {
  FRAME_CHIP_HEIGHTS,
  FRAME_CHIP_WIDTH,
} from "@broods/convex/model/canvasFrames";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  tidyCanvasLayout,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import {
  agentEdgePath,
  applyFramedNodeChanges,
  buildFramedGraph,
  expandBundleEdgeRemoval,
  flattenFramedNodes,
  serversByNode,
  type StageMcpServer,
} from "../app/lib/canvasFrameNodes";
import deployedStages from "./fixtures/deployedStages.json";

const NONE = new Set<string>();

/**
 * An agent over a cloud frame (cloud, spare) and a workspace frame (notes
 * mounted on cloud, wiki inheriting it), with a lone machine sandbox and a
 * lone machine MCP server as cards. Members sit on their slots.
 */
const NODES: Node[] = [
  node("agent", "agent", { x: 200, y: 0 }),
  node("cloud", "sandbox", { x: 8, y: 172 }),
  node("spare", "sandbox", { x: 8, y: 224 }),
  node(
    "mac",
    "sandbox",
    { x: 480, y: 144 },
    { config: { provider: "machine" } },
  ),
  node("notes", "workspace", { x: 248, y: 172 }),
  node("wiki", "workspace", { x: 248, y: 240 }),
  node("blender", "mcp", { x: 720, y: 144 }),
];

const EDGES: Edge[] = [
  edge("agent", "cloud"),
  edge("agent", "spare"),
  edge("agent", "mac"),
  edge("agent", "notes"),
  edge("agent", "wiki"),
  edge("agent", "blender"),
  {
    id: "mount:cloud-right-notes-left",
    source: "cloud",
    sourceHandle: "right",
    target: "notes",
    targetHandle: "left",
    type: "mount",
  },
];

const SERVERS: StageMcpServer[] = [
  {
    disabled: false,
    name: "blender",
    nodeId: "blender",
    sandbox: "mac",
    transport: "machine",
  },
];

const CLOUD_FRAME = "frame:agent:sandbox:cloud";
const WORKSPACE_FRAME = "frame:agent:workspace:s3";

describe("buildFramedGraph", () => {
  test("puts each frame before its members and flattens back to the flat nodes", () => {
    const { nodes } = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);
    const ids = nodes.map((item) => item.id);

    expect(ids.indexOf(CLOUD_FRAME)).toBeLessThan(ids.indexOf("cloud"));
    expect(nodes.find((item) => item.id === "cloud")).toMatchObject({
      draggable: false,
      parentId: CLOUD_FRAME,
      position: { x: 8, y: 28 },
    });
    expect(nodes.find((item) => item.id === "wiki")).toMatchObject({
      parentId: WORKSPACE_FRAME,
      position: { x: 8, y: 96 },
    });
    expect(flattenFramedNodes(nodes)).toStrictEqual(NODES);
  });

  test("leaves a group of one as a card with its own bottom-to-top edge", () => {
    const { edges, frames, nodes } = buildFramedGraph(
      NODES,
      EDGES,
      SERVERS,
      NONE,
      null,
    );

    expect(frames.map((frame) => frame.id)).toEqual([
      CLOUD_FRAME,
      WORKSPACE_FRAME,
    ]);
    expect(nodes.find((item) => item.id === "mac")).toBe(NODES[3]);
    expect(
      edges.find((item) => item.id === "xy-edge__agent-mac")?.data,
    ).toMatchObject({ route: { gutter: null } });
  });

  test("a moved frame carries its members' absolute positions", () => {
    const { nodes } = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);
    const moved = nodes.map((item) =>
      item.id === CLOUD_FRAME
        ? { ...item, position: { x: item.position.x + 48, y: 24 } }
        : item,
    );

    expect(
      flattenFramedNodes(moved).find((item) => item.id === "cloud")?.position,
    ).toEqual({ x: 56, y: 52 });
  });

  test("bundles an agent's edges into one frame's top and removing it removes each", () => {
    const { bundles, edges: display } = buildFramedGraph(
      NODES,
      EDGES,
      SERVERS,
      NONE,
      null,
    );
    const bundleId = `bundle:agent:${CLOUD_FRAME}`;
    const bundle = display.filter((item) => item.target === CLOUD_FRAME);

    expect(bundle).toHaveLength(1);
    expect(bundle[0]).toMatchObject({
      id: bundleId,
      source: "agent",
      target: CLOUD_FRAME,
      targetHandle: "top",
    });
    expect(
      expandBundleEdgeRemoval([{ id: bundleId, type: "remove" }], bundles),
    ).toEqual([
      { id: "xy-edge__agent-cloud", type: "remove" },
      { id: "xy-edge__agent-spare", type: "remove" },
    ]);
  });

  test("a bundle is locked when any edge it stands for is", () => {
    const edges = EDGES.map((item) =>
      item.target === "cloud" ? { ...item, deletable: false } : item,
    );
    const { edges: display } = buildFramedGraph(
      NODES,
      edges,
      SERVERS,
      NONE,
      null,
    );

    expect(
      display.find((item) => item.id === `bundle:agent:${CLOUD_FRAME}`),
    ).toMatchObject({ deletable: false });
  });

  test("draws the mount and the inherited sandbox apart where they share a handle", () => {
    const { edges } = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);
    const sides = edges.filter((item) => item.type === "mount");

    expect(sides.map((item) => [item.id, item.source, item.target])).toEqual([
      ["mount:cloud-right-notes-left", "cloud", "notes"],
      ["inherits:wiki-cloud", "wiki", "cloud"],
    ]);
    expect(sides[1]).toMatchObject({
      data: { displayOnly: true },
      deletable: false,
      sourceHandle: "left",
      targetHandle: "right",
    });
    // Both end on cloud's right handle: they fan along its side.
    const [mount, inherit] = sides.map((item) => sideRouteOf(item));
    expect(
      Math.abs(mount.sourceFan - inherit.targetFan),
    ).toBeGreaterThanOrEqual(8);
  });

  test("draws one inherited edge per distinct default of the agents sharing a workspace", () => {
    const nodes = [
      node("one", "agent", { x: 0, y: 0 }),
      node("two", "agent", { x: 480, y: 0 }),
      node("a", "sandbox", { x: 0, y: 144 }),
      node("b", "sandbox", { x: 480, y: 144 }),
      node("docs", "workspace", { x: 240, y: 144 }),
    ];
    const edges = [
      edge("one", "a"),
      edge("two", "b"),
      edge("one", "docs"),
      edge("two", "docs"),
    ];
    const { edges: display } = buildFramedGraph(nodes, edges, [], NONE, null);

    expect(
      display
        .filter((item) => item.id.startsWith("inherits:"))
        .map((item) => item.id),
    ).toEqual(["inherits:docs-a", "inherits:docs-b"]);
  });

  test("fans runs-on edges of two servers on one computer apart", () => {
    const nodes = [...NODES, node("render", "mcp", { x: 720, y: 288 })];
    const servers: StageMcpServer[] = [
      ...SERVERS,
      {
        disabled: false,
        name: "render",
        nodeId: "render",
        sandbox: "mac",
        transport: "machine",
      },
    ];
    const { edges } = buildFramedGraph(
      nodes,
      [...EDGES, edge("agent", "render")],
      servers,
      NONE,
      null,
    );
    const fans = edges
      .filter((item) => item.type === "runsOn")
      .map((item) => sideRouteOf(item).targetFan);

    expect(fans).toHaveLength(2);
    expect(Math.abs(fans[0] - fans[1])).toBeGreaterThanOrEqual(8);
  });

  test.each(["tracy", "large"] as const)(
    "the tidy layout of the deployed %s stage draws no edge through a box",
    (stage) => {
      const { edges, mcpServers, nodes } = deployedStages[stage];
      const servers: StageMcpServer[] = mcpServers;
      const flatEdges = edges.map(hydrateEdge);
      const positions = tidyCanvasLayout(
        nodes,
        flatEdges,
        serversByNode(servers),
      );
      const laid: Node[] = nodes.map((item) => ({
        ...item,
        position: positions.get(item.id) ?? item.position,
      }));
      const graph = buildFramedGraph(laid, flatEdges, servers, NONE, null);

      expect(crossings(graph.nodes, graph.edges)).toEqual([]);
    },
  );

  test("collapsing hides members and re-points their mount and inheritance to the frame", () => {
    const { nodes, edges } = buildFramedGraph(
      NODES,
      EDGES,
      SERVERS,
      new Set([WORKSPACE_FRAME]),
      null,
    );

    expect(nodes.find((item) => item.id === "notes")?.hidden).toBe(true);
    expect(nodes.find((item) => item.id === WORKSPACE_FRAME)?.height).toBe(84);
    expect(
      edges
        .filter((item) => item.type === "mount")
        .map((item) => [item.id, item.deletable]),
    ).toEqual([
      [`collapsed:cloud-right-${WORKSPACE_FRAME}-left`, false],
      [`inherits:${WORKSPACE_FRAME}-cloud`, false],
    ]);
  });

  test("draws runs-on from a machine server to the sandbox it names", () => {
    const { edges } = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);

    expect(edges.filter((item) => item.type === "runsOn")).toMatchObject([
      {
        deletable: false,
        id: "runs-on:blender-mac",
        reconnectable: false,
        selectable: false,
        source: "blender",
        sourceHandle: "left",
        target: "mac",
        targetHandle: "right",
        type: "runsOn",
      },
    ]);
  });

  test("leaves MCP nodes as cards until the server list has loaded", () => {
    const withGithub = [...NODES, node("github", "mcp", { x: 960, y: 144 })];
    const { frames } = buildFramedGraph(
      withGithub,
      [...EDGES, edge("agent", "github")],
      undefined,
      NONE,
      null,
    );

    expect(frames.some((frame) => frame.kind === "mcp")).toBe(false);
  });

  test("hands back the previous objects for frames and edges that did not change", () => {
    const first = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);
    const same = buildFramedGraph(NODES, EDGES, SERVERS, NONE, first);
    // The agent card moves 40px; its lanes are relative to its handles, so no
    // frame and no drawn edge changes.
    const dragged = NODES.map((item) =>
      item.id === "agent" ? { ...item, position: { x: 240, y: 0 } } : item,
    );
    const afterDrag = buildFramedGraph(dragged, EDGES, SERVERS, NONE, first);

    expect(same.nodes).toBe(first.nodes);
    expect(same.edges).toBe(first.edges);
    expect(afterDrag.edges).toBe(first.edges);
    expect(afterDrag.nodes.find((item) => item.id === CLOUD_FRAME)).toBe(
      first.nodes.find((item) => item.id === CLOUD_FRAME),
    );
  });

  test("rebuilds only the edge whose gutter flips when the agent crosses its target", () => {
    // A skill stacked under the cloud frame takes a gutter, on the side the
    // agent is on.
    const nodes = [...NODES, node("deep", "skill", { x: 0, y: 360 })];
    const edges = [...EDGES, edge("agent", "deep")];
    const first = buildFramedGraph(nodes, edges, SERVERS, NONE, null);
    const dragged = nodes.map((item) =>
      item.id === "agent" ? { ...item, position: { x: -240, y: 0 } } : item,
    );
    const afterDrag = buildFramedGraph(dragged, edges, SERVERS, NONE, first);
    const gutterOf = (graph: typeof first): number | undefined =>
      (
        graph.edges.find((item) => item.id === "xy-edge__agent-deep")?.data as
          | { route: AgentEdgeRoute }
          | undefined
      )?.route.gutter?.x;
    const rebuilt = afterDrag.edges
      .filter((item) => !first.edges.includes(item))
      .map((item) => item.id);

    expect(gutterOf(first)).toBeGreaterThan(176);
    expect(gutterOf(afterDrag)).toBeLessThan(0);
    expect(rebuilt).toEqual(["xy-edge__agent-deep"]);
  });
});

describe("applyFramedNodeChanges", () => {
  // Stored before frames: a third cloud sandbox is off its slot.
  const legacy = [...NODES, node("extra", "sandbox", { x: 30, y: 400 })];
  const legacyEdges = [...EDGES, edge("agent", "extra")];

  test("a measurement moves no member onto its slot", () => {
    const next = applyFramedNodeChanges(
      [
        {
          dimensions: { height: 44, width: 184 },
          id: "extra",
          type: "dimensions",
        },
      ],
      legacy,
      legacyEdges,
      SERVERS,
      NONE,
    );

    expect(next.map((item) => item.position)).toEqual(
      legacy.map((item) => item.position),
    );
  });

  test("a drag writes every member's slot", () => {
    const next = applyFramedNodeChanges(
      [{ id: "agent", position: { x: 240, y: 0 }, type: "position" }],
      legacy,
      legacyEdges,
      SERVERS,
      NONE,
    );

    expect(next.find((item) => item.id === "extra")?.position).toEqual({
      x: 8,
      y: 276,
    });
  });
});

describe("agentEdgePath", () => {
  test("drops to its bus and straight into the target's top", () => {
    const [path, labelX, labelY] = agentEdgePath(
      { x: 100, y: 96 },
      { x: 300, y: 144 },
      { busDrop: 12, gutter: null, targetFan: 0 },
    );

    expect(path).toBe(
      "M100 96 L100 102 Q100 108 106 108 L292 108 Q300 108 300 116 L300 144",
    );
    expect([labelX, labelY]).toEqual([300, 126]);
  });

  test("runs down its gutter and across the gap above the target", () => {
    const [path, labelX, labelY] = agentEdgePath(
      { x: 100, y: 96 },
      { x: 340, y: 432 },
      { busDrop: 20, gutter: { rise: 12, x: 232 }, targetFan: 0 },
    );

    expect(path).toBe(
      "M100 96 L100 108 Q100 116 108 116 L224 116 Q232 116 232 124 L232 412 Q232 420 240 420 L334 420 Q340 420 340 426 L340 432",
    );
    expect([labelX, labelY]).toEqual([232, 268]);
  });
});

function edge(source: string, target: string): Edge {
  return { id: `xy-edge__${source}-${target}`, source: source, target: target };
}

function node(
  id: string,
  type: string,
  position: { x: number; y: number },
  data: Record<string, unknown> = {},
): Node {
  return {
    data: { label: id, ...data },
    id: id,
    position: position,
    type: type,
  };
}

/**
 * Every drawn edge that runs through a top-level box other than the two
 * holding its ends, with each node at its drawn size: frames as set, cards at
 * the minimum, chips at their slot.
 */
function crossings(nodes: readonly Node[], edges: readonly Edge[]): string[] {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const boxes = new Map<string, LayoutRect>();
  const handles = new Map<string, { box: LayoutRect; outer: string }>();
  for (const item of nodes) {
    if (item.hidden) continue;
    const parent =
      item.parentId === undefined ? undefined : byId.get(item.parentId);
    if (!parent) {
      const box = {
        ...item.position,
        height: item.height ?? NODE_HEIGHT,
        width: item.width ?? NODE_WIDTH,
      };
      boxes.set(item.id, box);
      handles.set(item.id, { box: box, outer: item.id });
      continue;
    }
    const kind =
      item.type === "workspace" || item.type === "mcp" ? item.type : "sandbox";
    handles.set(item.id, {
      box: {
        height: FRAME_CHIP_HEIGHTS[kind],
        width: FRAME_CHIP_WIDTH,
        x: parent.position.x + item.position.x,
        y: parent.position.y + item.position.y,
      },
      outer: parent.id,
    });
  }

  return edges.flatMap((item): string[] => {
    const source = handles.get(item.source);
    const target = handles.get(item.target);
    const route: unknown = item.data?.route;
    if (!source || !target || typeof route !== "object" || route === null) {
      return [];
    }
    const points =
      "busDrop" in route
        ? agentEdgePoints(
            handlePoint(source.box, "bottom"),
            handlePoint(target.box, "top"),
            agentRouteOf(item),
          )
        : sideEdgePoints(
            handlePoint(
              source.box,
              item.sourceHandle === "left" ? "left" : "right",
            ),
            handlePoint(
              target.box,
              item.targetHandle === "left" ? "left" : "right",
            ),
            sideRouteOf(item),
          );

    return crossedBoxIds(
      points,
      boxes,
      new Set([source.outer, target.outer]),
    ).map((box) => `${item.id} crosses ${box}`);
  });
}

function agentRouteOf(item: Edge): AgentEdgeRoute {
  return (item.data as { route: AgentEdgeRoute }).route;
}

/** A stored edge as the canvas hydrates it: a mount's handles come from its id. */
function hydrateEdge(item: {
  id: string;
  source: string;
  target: string;
}): Edge {
  if (!item.id.startsWith("mount:")) return item;
  const rest = item.id.slice(`mount:${item.source}-`.length);
  const marker = `-${item.target}-`;
  const at = rest.indexOf(marker);

  return {
    ...item,
    sourceHandle: rest.slice(0, at),
    targetHandle: rest.slice(at + marker.length),
    type: "mount",
  };
}

function sideRouteOf(item: Edge): SideEdgeRoute {
  return (item.data as { route: SideEdgeRoute }).route;
}
