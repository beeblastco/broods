import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  applyCanvasDrop,
  canvasDropTarget,
  sameCanvasDrop,
  type CanvasDrop,
} from "../app/lib/canvasDropTarget";
import type { FlatGraph } from "../app/lib/canvasFrameEdits";
import { deriveGroups } from "../app/lib/canvasFrameNodes";

/**
 * One dashboard agent over a cloud frame (alpha, bravo), a workspace mounted on
 * alpha, and a lone cloud sandbox nothing wires yet. The frame's box runs from
 * (240, 144) to (432, 276): two chips, a header and its padding.
 */
const NODES: Node[] = [
  node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
  node("alpha", "sandbox", { x: 248, y: 172 }),
  node("bravo", "sandbox", { x: 248, y: 224 }),
  node("notes", "workspace", { x: 488, y: 172 }),
  node("lone", "sandbox", { x: 960, y: 480 }),
];

const EDGES: Edge[] = [
  edge("agent", "alpha"),
  edge("agent", "bravo"),
  edge("agent", "notes"),
];

const CLOUD_FRAME = "frame:agent:sandbox:cloud";

/** No frame in these graphs is collapsed. */
const NONE: ReadonlySet<string> = new Set();

/** Just right of the frame, close enough to be offered it, level with its first chip. */
const BESIDE_FIRST_CHIP = { x: 460, y: 144 };

describe("canvasDropTarget", () => {
  test("a card beside a frame it belongs in takes the slot under the cursor", () => {
    const drop = dropAt("lone", BESIDE_FIRST_CHIP);

    expect(drop?.frameId).toBe(CLOUD_FRAME);
    expect(drop?.refusal).toBeNull();
    expect(drop?.memberIds).toEqual(["alpha", "bravo"]);
    expect(drop?.ownerIds).toEqual(["agent"]);
    expect(drop?.slot).toBe(0);
  });

  test("the slot follows the cursor down the frame", () => {
    // A chip's middle is the boundary: 194 for alpha's slot, 246 for bravo's.
    expect(dropAt("lone", { x: 460, y: 148 })?.slot).toBe(1);
    expect(dropAt("lone", { x: 460, y: 200 })?.slot).toBe(2);
  });

  test("a collapsed group takes the card last, having no slot to aim at", () => {
    const drop = canvasDropTarget({
      collapsedFrames: new Set([CLOUD_FRAME]),
      expandedMemberId: null,
      graph: { edges: EDGES, mcpServers: [], nodes: NODES },
      nodeId: "lone",
      // Nearer, since a collapsed frame is one card wide and one card tall.
      position: { x: 450, y: 144 },
    });

    expect(drop?.frameId).toBe(CLOUD_FRAME);
    expect(drop?.refusal).toBeNull();
    expect(drop?.slot).toBe(2);
  });

  test("a card too far from any group is offered none", () => {
    expect(dropAt("lone", { x: 560, y: 144 })).toBeNull();
  });

  test("a workspace over a sandbox frame is refused in one sentence", () => {
    const drop = dropAt("notes", BESIDE_FIRST_CHIP);

    expect(drop?.frameId).toBe(CLOUD_FRAME);
    expect(drop?.refusal).toBe("A workspace joins no sandbox group.");
  });

  test("a card another agent also wires would group on its own, and says so", () => {
    const nodes = [
      ...NODES,
      node("other", "agent", { x: 720, y: 0 }, { agentConfigId: "cfg2" }),
      node("shared", "sandbox", BESIDE_FIRST_CHIP),
    ];
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: {
        edges: [...EDGES, edge("other", "shared")],
        mcpServers: [],
        nodes: nodes,
      },
      nodeId: "shared",
      position: BESIDE_FIRST_CHIP,
    });

    expect(drop?.refusal).toBe(
      "shared answers to other as well, so it groups on its own.",
    );
  });

  test("a link into a `broods/` project's group is refused in its own words", () => {
    // The `cli-` node id is what marks the edge as the project's, the way the
    // CLI sync writes every edge it owns.
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: {
        edges: [edge("cli-agent", "alpha"), edge("cli-agent", "bravo")],
        mcpServers: [],
        nodes: [
          node("cli-agent", "agent", { x: 240, y: 0 }, { managedBy: "cli" }),
          node("alpha", "sandbox", { x: 248, y: 172 }),
          node("bravo", "sandbox", { x: 248, y: 224 }),
          node("lone", "sandbox", BESIDE_FIRST_CHIP),
        ],
      },
      nodeId: "lone",
      position: BESIDE_FIRST_CHIP,
    });

    expect(drop?.refusal).toBe(
      "Code manages cli-agent. Add this link there and deploy.",
    );
  });

  test("a group the REST API owns refuses a card the API owns too", () => {
    // Plain ids, so only the two ends' ownership can refuse this one.
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: {
        edges: [edge("agent", "alpha"), edge("agent", "bravo")],
        mcpServers: [],
        nodes: [
          node("agent", "agent", { x: 240, y: 0 }, { managedBy: "api" }),
          node("alpha", "sandbox", { x: 248, y: 172 }),
          node("bravo", "sandbox", { x: 248, y: 224 }),
          node("lone", "sandbox", BESIDE_FIRST_CHIP, { managedBy: "api" }),
        ],
      },
      nodeId: "lone",
      position: BESIDE_FIRST_CHIP,
    });

    expect(drop?.refusal).toBe(
      "Code manages agent and lone. Add this link there and deploy.",
    );
  });

  test("a slot that would strand a mounted workspace is refused, not saved", () => {
    // `notes` is mounted on alpha, legal only because alpha is the agent's first
    // sandbox. Dropping `lone` above alpha would make lone first instead.
    const graph = {
      edges: [
        edge("agent", "alpha"),
        edge("agent", "bravo"),
        edge("agent", "notes"),
        {
          id: "mount:alpha-right-notes-left",
          source: "alpha",
          sourceHandle: "right",
          target: "notes",
          targetHandle: "left",
          type: "mount",
        },
      ],
      mcpServers: [],
      nodes: [
        node(
          "agent",
          "agent",
          { x: 240, y: 0 },
          { agentConfigId: "cfg", sandboxOrder: ["alpha", "bravo"] },
        ),
        node("alpha", "sandbox", { x: 248, y: 172 }),
        node("bravo", "sandbox", { x: 248, y: 224 }),
        node("notes", "workspace", { x: 700, y: 400 }),
        node("lone", "sandbox", BESIDE_FIRST_CHIP),
      ],
    };
    const top = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: graph,
      nodeId: "lone",
      position: BESIDE_FIRST_CHIP,
    });
    const bottom = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: graph,
      nodeId: "lone",
      position: { x: 460, y: 200 },
    });

    expect(top?.slot).toBe(0);
    expect(top?.refusal).toContain("notes");
    // Below both chips it changes no default, so it is taken.
    expect(bottom?.slot).toBe(2);
    expect(bottom?.refusal).toBeNull();
  });

  test("a card pulled out of a drawn frame is no partner for a new group", () => {
    // Dropping onto `gamma` would clear its flag and drag it back into the frame
    // it was pulled out of, which is not the pair the preview would promise.
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: {
        edges: [
          edge("agent", "alpha"),
          edge("agent", "bravo"),
          edge("agent", "gamma"),
        ],
        mcpServers: [],
        nodes: [
          node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
          node("alpha", "sandbox", { x: 248, y: 172 }),
          node("bravo", "sandbox", { x: 248, y: 224 }),
          node("gamma", "sandbox", { x: 900, y: 600 }, { ungrouped: true }),
          node("lone", "sandbox", { x: 900, y: 700 }),
        ],
      },
      nodeId: "lone",
      position: { x: 900, y: 700 },
    });

    expect(drop).toBeNull();
  });

  test("two loose cards form a group, and the box is offered quietly", () => {
    const nodes = [
      node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
      node("alpha", "sandbox", { x: 248, y: 172 }),
      node("lone", "sandbox", { x: 440, y: 172 }),
    ];
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: { edges: [edge("agent", "alpha")], mcpServers: [], nodes: nodes },
      nodeId: "lone",
      position: { x: 440, y: 172 },
    });

    expect(drop?.frameId).toBeNull();
    expect(drop?.memberIds).toEqual(["alpha"]);
    expect(drop?.refusal).toBeNull();
    expect(drop?.label).toBe("Cloud sandbox");
  });

  test("two loose cards that share no group say nothing at all", () => {
    const nodes = [
      node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
      node("alpha", "sandbox", { x: 248, y: 172 }),
      node("notes", "workspace", { x: 440, y: 172 }),
    ];

    expect(
      canvasDropTarget({
        collapsedFrames: NONE,
        expandedMemberId: null,
        graph: {
          edges: [edge("agent", "alpha")],
          mcpServers: [],
          nodes: nodes,
        },
        nodeId: "notes",
        position: { x: 440, y: 172 },
      }),
    ).toBeNull();
  });

  test("where code owns the order, the slot offered is the one the rules give", () => {
    const graph = codeManagedGraph();
    // The cursor is on the first chip, but a `broods/` project owns the order.
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: graph,
      nodeId: "extra",
      position: BESIDE_FIRST_CHIP,
    });

    expect(drop?.refusal).toBeNull();
    expect(drop?.slot).toBe(2);
  });
});

describe("applyCanvasDrop", () => {
  test("the card is wired to every agent the group answers to", () => {
    const drop = dropAt("lone", BESIDE_FIRST_CHIP);
    const after = applyCanvasDrop(
      { edges: EDGES, mcpServers: [], nodes: NODES },
      drop!,
    );

    expect(after.edges).toHaveLength(EDGES.length + 1);
    expect(
      after.edges.some(
        (item) => item.source === "agent" && item.target === "lone",
      ),
    ).toBe(true);
  });

  test("the card lands in the slot it was dropped on", () => {
    const drop = dropAt("lone", BESIDE_FIRST_CHIP);
    const after = applyCanvasDrop(
      { edges: EDGES, mcpServers: [], nodes: NODES },
      drop!,
    );

    expect(dataOf(after.nodes, "agent").sandboxOrder).toEqual([
      "lone",
      "alpha",
      "bravo",
    ]);
    expect(memberIdsOf(after, "lone")).toEqual(["lone", "alpha", "bravo"]);
  });

  test("dropping under a chip lands under it", () => {
    const drop = dropAt("lone", { x: 460, y: 148 });
    const after = applyCanvasDrop(
      { edges: EDGES, mcpServers: [], nodes: NODES },
      drop!,
    );

    expect(memberIdsOf(after, "lone")).toEqual(["alpha", "lone", "bravo"]);
  });

  test("a group that is not sandboxes keeps its order on its own members", () => {
    const nodes = [
      node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
      node("docs", "workspace", { x: 248, y: 172 }),
      node("notes", "workspace", { x: 248, y: 224 }),
      node("uploads", "workspace", BESIDE_FIRST_CHIP),
    ];
    const edges = [edge("agent", "docs"), edge("agent", "notes")];
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: { edges: edges, mcpServers: [], nodes: nodes },
      nodeId: "uploads",
      position: BESIDE_FIRST_CHIP,
    });
    const after = applyCanvasDrop(
      { edges: edges, mcpServers: [], nodes: nodes },
      drop!,
    );

    expect(dataOf(after.nodes, "uploads").frameSlot).toEqual({
      group: "frame:agent:workspace:s3",
      slot: 0,
    });
    expect(dataOf(after.nodes, "docs").frameSlot).toEqual({
      group: "frame:agent:workspace:s3",
      slot: 1,
    });
    expect(dataOf(after.nodes, "notes").frameSlot).toEqual({
      group: "frame:agent:workspace:s3",
      slot: 2,
    });
    expect(memberIdsOf(after, "uploads")).toEqual(["uploads", "docs", "notes"]);
  });

  test("a machine MCP group keeps the order its computers give it", () => {
    const nodes = [
      node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
      node(
        "mac",
        "sandbox",
        { x: 40, y: 172 },
        { config: { provider: "machine" } },
      ),
      node("srv-one", "mcp", { x: 248, y: 172 }),
      node("srv-two", "mcp", { x: 248, y: 224 }),
      node("srv-three", "mcp", BESIDE_FIRST_CHIP, { ungrouped: true }),
    ];
    const edges = [
      edge("agent", "mac"),
      edge("agent", "srv-one"),
      edge("agent", "srv-two"),
      edge("agent", "srv-three"),
    ];
    const graph = {
      edges: edges,
      mcpServers: ["srv-one", "srv-two", "srv-three"].map((nodeId) => ({
        disabled: false,
        name: nodeId,
        nodeId: nodeId,
        sandbox: "mac",
        transport: "machine" as const,
      })),
      nodes: nodes,
    };
    // Aimed at the first chip, which for this group is not the canvas's call.
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: graph,
      nodeId: "srv-three",
      position: BESIDE_FIRST_CHIP,
    });
    const after = applyCanvasDrop(graph, drop!);

    expect(drop?.refusal).toBeNull();
    expect(dataOf(after.nodes, "srv-three").frameSlot).toBeUndefined();
    expect(dataOf(after.nodes, "srv-one").frameSlot).toBeUndefined();
    // Still the order the labels and the computer give it.
    expect(
      deriveGroups(after.nodes, after.edges, graph.mcpServers).find((group) =>
        group.memberIds.includes("srv-three"),
      )?.memberIds,
    ).toEqual(["srv-one", "srv-three", "srv-two"]);
  });

  test("a card put back in its group loses the flag that kept it out", () => {
    const graph = codeManagedGraph();
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: graph,
      nodeId: "extra",
      position: BESIDE_FIRST_CHIP,
    });
    const after = applyCanvasDrop(graph, drop!);

    expect(dataOf(after.nodes, "extra").ungrouped).toBeUndefined();
    expect(memberIdsOf(after, "extra")).toEqual(["alpha", "bravo", "extra"]);
  });

  test("an order code manages is left exactly as its project wrote it", () => {
    const graph = codeManagedGraph();
    const drop = canvasDropTarget({
      collapsedFrames: NONE,
      expandedMemberId: null,
      graph: graph,
      nodeId: "extra",
      position: BESIDE_FIRST_CHIP,
    });
    const after = applyCanvasDrop(graph, drop!);

    expect(dataOf(after.nodes, "cli-agent").sandboxOrder).toEqual([
      "alpha",
      "bravo",
    ]);
  });
});

describe("sameCanvasDrop", () => {
  const drop: CanvasDrop = {
    frameId: CLOUD_FRAME,
    groupId: CLOUD_FRAME,
    key: "cloud",
    kind: "sandbox",
    label: "Cloud sandbox",
    memberIds: ["alpha", "bravo"],
    nodeId: "lone",
    ownerIds: ["agent"],
    refusal: null,
    slot: 0,
  };

  test("two offers of the same slot in the same group are the same", () => {
    expect(sameCanvasDrop(drop, { ...drop })).toBe(true);
    expect(sameCanvasDrop(null, null)).toBe(true);
  });

  test("a different slot, group, reason or member list is a different offer", () => {
    expect(sameCanvasDrop(drop, { ...drop, slot: 1 })).toBe(false);
    expect(sameCanvasDrop(drop, { ...drop, frameId: null })).toBe(false);
    expect(sameCanvasDrop(drop, { ...drop, refusal: "no" })).toBe(false);
    expect(sameCanvasDrop(drop, { ...drop, memberIds: ["alpha"] })).toBe(false);
    expect(sameCanvasDrop(drop, null)).toBe(false);
  });
});

/**
 * A `broods/` project's agent over a cloud frame, with a third sandbox it wires
 * that was pulled out of the group by hand.
 */
function codeManagedGraph(): FlatGraph {
  return {
    edges: [
      edge("cli-agent", "alpha"),
      edge("cli-agent", "bravo"),
      edge("cli-agent", "extra"),
    ],
    mcpServers: [],
    nodes: [
      node(
        "cli-agent",
        "agent",
        { x: 240, y: 0 },
        { managedBy: "cli", sandboxOrder: ["alpha", "bravo"] },
      ),
      node("alpha", "sandbox", { x: 248, y: 172 }),
      node("bravo", "sandbox", { x: 248, y: 224 }),
      node("extra", "sandbox", BESIDE_FIRST_CHIP, { ungrouped: true }),
    ],
  };
}

function dataOf(nodes: readonly Node[], id: string): Record<string, unknown> {
  return nodes.find((item) => item.id === id)?.data ?? {};
}

/** The fixture's answer for a card dragged to this spot. */
function dropAt(nodeId: string, position: Node["position"]): CanvasDrop | null {
  return canvasDropTarget({
    collapsedFrames: NONE,
    expandedMemberId: null,
    graph: { edges: EDGES, mcpServers: [], nodes: NODES },
    nodeId: nodeId,
    position: position,
  });
}

function edge(source: string, target: string): Edge {
  return { id: `xy-edge__${source}-${target}`, source: source, target: target };
}

/** The group a node sits in once a drop has been applied, in slot order. */
function memberIdsOf(
  graph: { edges: readonly Edge[]; nodes: readonly Node[] },
  nodeId: string,
): string[] {
  return (
    deriveGroups(graph.nodes, graph.edges, []).find((group) =>
      group.memberIds.includes(nodeId),
    )?.memberIds ?? []
  );
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
