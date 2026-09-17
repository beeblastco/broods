import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  applyFramedNodeChanges,
  buildFramedGraph,
  bundleEdgePath,
  expandBundleEdgeRemoval,
  flattenFramedNodes,
  type StageMcpServer,
} from "../app/lib/canvasFrameNodes";

const NONE = new Set<string>();

/** An agent with two sandboxes, one mounted workspace and one machine MCP server. */
const NODES: Node[] = [
  node("agent", "agent", { x: 200, y: 0 }),
  node("cloud", "sandbox", { x: 8, y: 172 }),
  node(
    "mac",
    "sandbox",
    { x: 400, y: 172 },
    { config: { provider: "machine" } },
  ),
  node("notes", "workspace", { x: 228, y: 172 }),
  node("blender", "mcp", { x: 600, y: 172 }),
];

const EDGES: Edge[] = [
  edge("agent", "cloud"),
  edge("agent", "mac"),
  edge("agent", "notes"),
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
    expect(flattenFramedNodes(nodes)).toStrictEqual(NODES);
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

  test("bundles an agent's edges into one frame and removing it removes each", () => {
    const twoClouds = [...NODES, node("spare", "sandbox", { x: 8, y: 224 })];
    const edges = [...EDGES, edge("agent", "spare")];
    const { bundles, edges: display } = buildFramedGraph(
      twoClouds,
      edges,
      SERVERS,
      NONE,
      null,
    );
    const bundleId = `bundle:agent:${CLOUD_FRAME}`;

    expect(display.filter((item) => item.target === CLOUD_FRAME)).toEqual([
      {
        id: bundleId,
        source: "agent",
        target: CLOUD_FRAME,
        targetHandle: "left",
      },
    ]);
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

  test("collapsing hides members and re-points their mount to the frame", () => {
    const { nodes, edges } = buildFramedGraph(
      NODES,
      EDGES,
      SERVERS,
      new Set([WORKSPACE_FRAME]),
      null,
    );

    expect(nodes.find((item) => item.id === "notes")?.hidden).toBe(true);
    expect(nodes.find((item) => item.id === WORKSPACE_FRAME)?.height).toBe(84);
    expect(edges.filter((item) => item.type === "mount")).toEqual([
      {
        deletable: false,
        id: `collapsed:cloud-right-${WORKSPACE_FRAME}-left`,
        reconnectable: false,
        source: "cloud",
        sourceHandle: "right",
        target: WORKSPACE_FRAME,
        targetHandle: "left",
        type: "mount",
      },
    ]);
  });

  test("draws runs-on from a machine server to the sandbox it names", () => {
    const { edges } = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);

    expect(edges.filter((item) => item.type === "runsOn")).toEqual([
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
    const { frames, nodes } = buildFramedGraph(
      NODES,
      EDGES,
      undefined,
      NONE,
      null,
    );

    expect(frames.some((frame) => frame.kind === "mcp")).toBe(false);
    expect(nodes.find((item) => item.id === "blender")).toBe(NODES[4]);
  });

  test("hands back the previous objects for frames and edges that did not change", () => {
    const first = buildFramedGraph(NODES, EDGES, SERVERS, NONE, null);
    const same = buildFramedGraph(NODES, EDGES, SERVERS, NONE, first);
    // The agent card moves; no frame and no drawn edge changes.
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
});

describe("applyFramedNodeChanges", () => {
  // Stored before frames: the second cloud sandbox is off its slot.
  const legacy = [...NODES, node("spare", "sandbox", { x: 30, y: 300 })];
  const legacyEdges = [...EDGES, edge("agent", "spare")];

  test("a measurement moves no member onto its slot", () => {
    const next = applyFramedNodeChanges(
      [
        {
          dimensions: { height: 44, width: 184 },
          id: "spare",
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

    expect(next.find((item) => item.id === "spare")?.position).toEqual({
      x: 8,
      y: 224,
    });
  });
});

describe("bundleEdgePath", () => {
  test("turns under the agent and runs down the gutter left of the frame", () => {
    const [path, labelX, labelY] = bundleEdgePath(
      { x: 300, y: 96 },
      { x: 480, y: 200 },
    );

    expect(path).toBe(
      "M300 96 L300 112 Q300 120 308 120 L462 120 Q470 120 470 128 L470 195 Q470 200 475 200 L480 200",
    );
    expect([labelX, labelY]).toEqual([470, 160]);
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
