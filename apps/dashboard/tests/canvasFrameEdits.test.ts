import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  agreedSandboxOrderNumbers,
  frameMemberActions,
  introducedRuntimeRefsProblem,
  makeDefaultSandbox,
  reconcileFramePositions,
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
    const edges = EDGES.filter((item) => item.target !== "alpha");
    const unmounted = edges.filter((item) => item.type !== "mount");
    const nodes = reconcileFramePositions(
      { edges: EDGES, mcpServers: [], nodes: NODES },
      { edges: unmounted, mcpServers: [], nodes: NODES },
    );
    const alpha = positionOf(nodes, "alpha");

    // bravo slides into slot 0 of the frame that stayed put.
    expect(positionOf(nodes, "bravo")).toEqual({ x: 248, y: 172 });
    // The frame box is 200 wide and 80 tall now; alpha's card clears it.
    const clear =
      alpha.x >= CLOUD_ORIGIN.x + 200 ||
      alpha.x + 176 <= CLOUD_ORIGIN.x ||
      alpha.y >= CLOUD_ORIGIN.y + 80 ||
      alpha.y + 96 <= CLOUD_ORIGIN.y;
    expect(clear).toBe(true);
  });

  test("a server that gains a transport moves to a frame clear of the others", () => {
    const servers: StageMcpServer[] = [
      {
        disabled: false,
        name: "github",
        nodeId: "github",
        sandbox: null,
        transport: "http",
      },
    ];
    const nodes = [...NODES, node("github", "mcp", { x: 248, y: 400 })];
    const edges = [...EDGES, edge("agent", "github")];
    const withSearch = [...nodes, node("search", "mcp", { x: 248, y: 452 })];
    const searchEdges = [...edges, edge("agent", "search")];
    const settled = reconcileFramePositions(
      { edges: searchEdges, mcpServers: servers, nodes: withSearch },
      {
        edges: searchEdges,
        mcpServers: [
          ...servers,
          {
            disabled: false,
            name: "search",
            nodeId: "search",
            sandbox: null,
            transport: "hosted",
          },
        ],
        nodes: withSearch,
      },
    );
    const search = positionOf(settled, "search");
    const github = positionOf(settled, "github");

    // The url frame keeps its origin; search's new frame does not overlap it.
    expect(github).toEqual({ x: 248, y: 400 });
    expect(search.y >= github.y + 44 + 8 || search.x >= github.x + 200).toBe(
      true,
    );
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

describe("agreedSandboxOrderNumbers", () => {
  test("numbers a shared sandbox only when its agents order it the same", () => {
    const nodes = [...NODES, node("second", "agent", { x: 720, y: 0 })];
    // bravo is second for `agent` and first, alone, for `second`.
    const edges = [...EDGES, edge("second", "bravo")];

    expect([...agreedSandboxOrderNumbers(nodes, edges)]).toEqual([
      ["alpha", 1],
    ]);
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

function positionOf(nodes: readonly Node[], id: string): Node["position"] {
  return nodes.find((item) => item.id === id)?.position ?? { x: NaN, y: NaN };
}
