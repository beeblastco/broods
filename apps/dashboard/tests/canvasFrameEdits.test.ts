import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  acceptsNewMember,
  frameGroupActions,
  frameMemberActions,
  introducedRuntimeRefsProblem,
  makeDefaultSandbox,
  reconcileFramePositions,
  setUngrouped,
} from "../app/lib/canvasFrameEdits";
import type { StageMcpServer } from "../app/lib/canvasFrameNodes";

/**
 * A dashboard agent over a cloud frame (alpha, bravo), a workspace mounted on
 * alpha, and a lone cloud card nothing wires yet.
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
  {
    id: "mount:alpha-right-notes-left",
    source: "alpha",
    sourceHandle: "right",
    target: "notes",
    targetHandle: "left",
    type: "mount",
  },
];

const CLOUD_ORIGIN = { x: 240, y: 144 };

describe("reconcileFramePositions", () => {
  test("a card wired into a frame takes its next slot and the frame stays", () => {
    const edges = [...EDGES, edge("agent", "lone")];
    const nodes = reconcileFramePositions(
      { edges: EDGES, mcpServers: [], nodes: NODES },
      { edges: edges, mcpServers: [], nodes: NODES },
    );

    expect(positionOf(nodes, "alpha")).toEqual({ x: 248, y: 172 });
    expect(positionOf(nodes, "lone")).toEqual({
      x: CLOUD_ORIGIN.x + 8,
      y: CLOUD_ORIGIN.y + 28 + 2 * 52,
    });
  });

  test("the slot-0 member leaving keeps the frame and moves the leaver clear of it", () => {
    const nodes = [...NODES, node("charlie", "sandbox", { x: 248, y: 276 })];
    const edges = [...EDGES, edge("agent", "charlie")];
    const unmounted = edges.filter(
      (item) => item.target !== "alpha" && item.type !== "mount",
    );
    const settled = reconcileFramePositions(
      { edges: edges, mcpServers: [], nodes: nodes },
      { edges: unmounted, mcpServers: [], nodes: nodes },
    );

    // bravo and charlie slide up in the frame that stayed put.
    expect(positionOf(settled, "bravo")).toEqual({ x: 248, y: 172 });
    expect(positionOf(settled, "charlie")).toEqual({ x: 248, y: 224 });
    // The frame box is 200 wide and 132 tall now; alpha's card clears it.
    expect(clearOf(positionOf(settled, "alpha"), CLOUD_ORIGIN, 200, 132)).toBe(
      true,
    );
  });

  test("a frame down to one member hands its spot to that member's card", () => {
    const unmounted = EDGES.filter(
      (item) => item.target !== "alpha" && item.type !== "mount",
    );
    const settled = reconcileFramePositions(
      { edges: EDGES, mcpServers: [], nodes: NODES },
      { edges: unmounted, mcpServers: [], nodes: NODES },
    );

    expect(positionOf(settled, "bravo")).toEqual(CLOUD_ORIGIN);
    expect(clearOf(positionOf(settled, "alpha"), CLOUD_ORIGIN, 176, 96)).toBe(
      true,
    );
  });

  test("a lone card that gains a second member grows into a frame where it stood", () => {
    const nodes = [
      ...NODES.map((item) =>
        item.id === "notes" ? { ...item, position: { x: 480, y: 144 } } : item,
      ),
      node("docs", "workspace", { x: 960, y: 720 }),
    ];
    const edges = [...EDGES, edge("agent", "docs")];
    const settled = reconcileFramePositions(
      { edges: EDGES, mcpServers: [], nodes: nodes },
      { edges: edges, mcpServers: [], nodes: nodes },
    );

    // The frame's box starts where the notes card stood; its slots go by label.
    expect(positionOf(settled, "docs")).toEqual({ x: 488, y: 172 });
    expect(positionOf(settled, "notes")).toEqual({ x: 488, y: 224 });
  });

  test("a server that changes transport leaves its frame and steps clear of it", () => {
    const servers = ["github", "linear", "search"].map(
      (name): StageMcpServer => ({
        disabled: false,
        name: name,
        nodeId: name,
        sandbox: null,
        transport: "http",
      }),
    );
    const nodes = [
      ...NODES,
      node("github", "mcp", { x: 248, y: 428 }),
      node("linear", "mcp", { x: 248, y: 480 }),
      node("search", "mcp", { x: 248, y: 532 }),
    ];
    const edges = [
      ...EDGES,
      edge("agent", "github"),
      edge("agent", "linear"),
      edge("agent", "search"),
    ];
    const settled = reconcileFramePositions(
      { edges: edges, mcpServers: servers, nodes: nodes },
      {
        edges: edges,
        mcpServers: servers.map((server) =>
          server.nodeId === "search"
            ? { ...server, transport: "hosted" as const }
            : server,
        ),
        nodes: nodes,
      },
    );

    // The url frame keeps its origin; search's card clears it.
    expect(positionOf(settled, "github")).toEqual({ x: 248, y: 428 });
    expect(
      clearOf(positionOf(settled, "search"), { x: 240, y: 400 }, 200, 132),
    ).toBe(true);
  });

  test("moves nothing when no frame changes, even members off their slots", () => {
    const legacy = NODES.map((item) =>
      item.id === "bravo" ? { ...item, position: { x: 300, y: 330 } } : item,
    );
    const renamed = legacy.map((item) =>
      item.id === "notes"
        ? { ...item, data: { ...item.data, readOnly: true } }
        : item,
    );

    expect(
      reconcileFramePositions(
        { edges: EDGES, mcpServers: [], nodes: legacy },
        { edges: EDGES, mcpServers: [], nodes: renamed },
      ),
    ).toBe(renamed);
  });
});

describe("pulling members out of a group", () => {
  const GRAPH = { edges: EDGES, mcpServers: [], nodes: NODES };

  test("a member can leave its frame or dissolve it, a lone card can do neither", () => {
    expect(frameGroupActions(GRAPH, "alpha")).toEqual([
      { frameLabel: "Cloud sandbox", kind: "pull-out", nodeIds: ["alpha"] },
      {
        frameLabel: "Cloud sandbox",
        kind: "ungroup-all",
        nodeIds: ["alpha", "bravo"],
      },
    ]);
    expect(frameGroupActions(GRAPH, "lone")).toEqual([]);
  });

  test("the flag keeps the node out of its group and clearing it puts it back", () => {
    const pulled = setUngrouped(NODES, ["alpha"], true);

    expect(pulled.find((item) => item.id === "alpha")?.data.ungrouped).toBe(
      true,
    );
    expect(
      frameGroupActions({ ...GRAPH, nodes: pulled }, "alpha").map(
        (action) => action.kind,
      ),
    ).toEqual(["rejoin"]);
    expect(
      setUngrouped(pulled, ["alpha"], false).find((item) => item.id === "alpha")
        ?.data,
    ).toEqual({ label: "alpha" });
    // A node that already reads that way is handed back as it came, so the
    // canvas does not re-render it.
    expect(setUngrouped(NODES, ["alpha"], false)[1]).toBe(NODES[1]);
  });

  test("a card left alone by the pull-out offers to go back, with nobody else", () => {
    const pulled = { ...GRAPH, nodes: setUngrouped(NODES, ["alpha"], true) };

    expect(frameGroupActions(pulled, "alpha")).toEqual([
      { frameLabel: "Cloud sandbox", kind: "rejoin", nodeIds: ["alpha"] },
    ]);
  });

  test("going back after an ungroup-all takes the rest of the group with it", () => {
    const nodes = setUngrouped(NODES, ["alpha", "bravo"], true);

    expect(frameGroupActions({ ...GRAPH, nodes: nodes }, "bravo")).toEqual([
      {
        frameLabel: "Cloud sandbox",
        kind: "rejoin",
        nodeIds: ["alpha", "bravo"],
      },
    ]);
  });

  test("only a frame a new node's own defaults would join takes one", () => {
    const [cloud] = frameGroupActions(GRAPH, "alpha");

    expect(cloud.frameLabel).toBe("Cloud sandbox");
    expect(
      acceptsNewMember({
        id: "frame:agent:sandbox:cloud",
        key: "cloud",
        kind: "sandbox",
        label: "Cloud sandbox",
        memberIds: ["alpha", "bravo"],
        ownerIds: ["agent"],
      }),
    ).toBe(true);
    expect(
      acceptsNewMember({
        id: "frame:agent:sandbox:machine",
        key: "machine",
        kind: "sandbox",
        label: "Your computer",
        memberIds: ["mac", "air"],
        ownerIds: ["agent"],
      }),
    ).toBe(false);
  });
});

describe("runtime ref guards", () => {
  test("make default is refused while a workspace is mounted on the current default", () => {
    const [makeDefault] = frameMemberActions(NODES, EDGES, "bravo");

    expect(makeDefault).toEqual({
      agentId: "agent",
      agentLabel: null,
      disabledReason: "notes is mounted on alpha",
      kind: "make-default",
    });
    // Unmounted, the same move is allowed and puts bravo first.
    const unmounted = EDGES.filter((item) => item.type !== "mount");
    const [allowed] = frameMemberActions(NODES, unmounted, "bravo");
    expect(allowed).toMatchObject({ disabledReason: null });
    const [agent] = makeDefaultSandbox(NODES, unmounted, "agent", "bravo");
    expect(agent.data.sandboxOrder).toEqual(["bravo", "alpha"]);
  });

  test("wiring an agent to a sandbox that backs its workspace, after its default, is refused", () => {
    const mountedLone: Edge = {
      id: "mount:lone-right-notes-left",
      source: "lone",
      sourceHandle: "right",
      target: "notes",
      targetHandle: "left",
      type: "mount",
    };
    const edges = EDGES.filter((item) => item.type !== "mount").concat(
      mountedLone,
    );

    expect(
      introducedRuntimeRefsProblem(
        { edges: edges, nodes: NODES },
        { edges: [...edges, edge("agent", "lone")], nodes: NODES },
      ),
    ).toEqual({
      agentId: "agent",
      sandboxId: "sb_lone",
      sandboxLabel: "lone",
      workspaceId: "ws_notes",
      workspaceName: "notes",
    });
  });

  test("renaming a sandbox or workspace in a graph that already breaks the rule is not refused", () => {
    // bravo is second and backs notes: saved like this before the check existed.
    const broken = EDGES.map((item) =>
      item.type === "mount" ? { ...item, source: "bravo" } : item,
    );
    const renamed = NODES.map((item) =>
      item.id === "bravo" || item.id === "notes"
        ? {
            ...item,
            data: {
              ...item.data,
              label: `${item.id}-renamed`,
              mountName: `${item.id}-renamed`,
            },
          }
        : item,
    );

    expect(
      introducedRuntimeRefsProblem(
        { edges: broken, nodes: NODES },
        { edges: broken, nodes: renamed },
      ),
    ).toBeNull();
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

/** Whether a card at `card` stays off the box at `origin`. */
function clearOf(
  card: Node["position"],
  origin: Node["position"],
  width: number,
  height: number,
): boolean {
  return (
    card.x >= origin.x + width ||
    card.x + 176 <= origin.x ||
    card.y >= origin.y + height ||
    card.y + 96 <= origin.y
  );
}

function positionOf(nodes: readonly Node[], id: string): Node["position"] {
  return nodes.find((item) => item.id === id)?.position ?? { x: NaN, y: NaN };
}
