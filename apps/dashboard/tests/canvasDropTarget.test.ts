import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  applyCanvasDrop,
  canvasDropTarget,
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

  test("wiring code owns is refused in the words the canvas already uses", () => {
    const nodes = [
      node("cli-agent", "agent", { x: 240, y: 0 }, { managedBy: "cli" }),
      node("alpha", "sandbox", { x: 248, y: 172 }),
      node("bravo", "sandbox", { x: 248, y: 224 }),
      node("lone", "sandbox", BESIDE_FIRST_CHIP),
    ];
    const drop = canvasDropTarget({
      expandedMemberId: null,
      graph: {
        edges: [edge("cli-agent", "alpha"), edge("cli-agent", "bravo")],
        mcpServers: [],
        nodes: nodes,
      },
      nodeId: "lone",
      position: BESIDE_FIRST_CHIP,
    });

    expect(drop?.refusal).toContain("Code manages");
  });

  test("two loose cards form a group, and the box is offered quietly", () => {
    const nodes = [
      node("agent", "agent", { x: 240, y: 0 }, { agentConfigId: "cfg" }),
      node("alpha", "sandbox", { x: 248, y: 172 }),
      node("lone", "sandbox", { x: 440, y: 172 }),
    ];
    const drop = canvasDropTarget({
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
      expandedMemberId: null,
      graph: { edges: edges, mcpServers: [], nodes: nodes },
      nodeId: "uploads",
      position: BESIDE_FIRST_CHIP,
    });
    const after = applyCanvasDrop(
      { edges: edges, mcpServers: [], nodes: nodes },
      drop!,
    );

    expect(dataOf(after.nodes, "uploads").frameOrder).toBe(0);
    expect(dataOf(after.nodes, "docs").frameOrder).toBe(1);
    expect(dataOf(after.nodes, "notes").frameOrder).toBe(2);
    expect(memberIdsOf(after, "uploads")).toEqual(["uploads", "docs", "notes"]);
  });

  test("a card put back in its group loses the flag that kept it out", () => {
    const graph = codeManagedGraph();
    const drop = canvasDropTarget({
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
