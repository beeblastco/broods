import { describe, expect, it } from "vitest";
import {
  agreedSandboxOrderNumbers,
  deriveCanvasGroups,
  frameGroupOf,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  agentRefCounts,
  runsOnSandboxIds,
  sandboxOrderNumbers,
  workspaceOnlySandboxIds,
  workspaceSandboxIds,
  type McpServersByNode,
} from "../model/canvasFrames";
import type { LayoutEdge, LayoutNode } from "../model/canvasLayout";

const NO_SERVERS: McpServersByNode = new Map();

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): LayoutNode {
  return { id: id, type: type, data: { label: id, ...data } };
}

function edge(source: string, target: string): LayoutEdge {
  return { id: `xy-edge__${source}-${target}`, source: source, target: target };
}

describe("frameGroupOf", () => {
  it("groups sandboxes by where they run", () => {
    expect(
      frameGroupOf(
        node("s1", "sandbox", { config: { provider: "machine" } }),
        NO_SERVERS,
      ),
    ).toEqual({ key: "machine", kind: "sandbox", label: "Your computer" });
    expect(
      frameGroupOf(
        node("s2", "sandbox", { config: { provider: "lambda" } }),
        NO_SERVERS,
      ),
    ).toEqual({ key: "cloud", kind: "sandbox", label: "Cloud sandbox" });
  });

  it("groups workspaces by storage provider", () => {
    expect(
      frameGroupOf(
        node("w1", "workspace", { config: { storage: { provider: "s3" } } }),
        NO_SERVERS,
      ),
    ).toEqual({ key: "s3", kind: "workspace", label: "Workspaces" });
  });

  it("groups MCP servers by saved transport, and unsaved ones apart", () => {
    const transports: McpServersByNode = new Map([
      ["m1", { sandbox: null, transport: "machine" }],
    ]);

    expect(frameGroupOf(node("m1", "mcp"), transports)).toEqual({
      key: "machine",
      kind: "mcp",
      label: "MCP · your computer",
    });
    expect(frameGroupOf(node("m2", "mcp"), transports)).toEqual({
      key: "unsaved",
      kind: "mcp",
      label: "MCP",
    });
  });

  it("never frames a skill", () => {
    expect(frameGroupOf(node("k1", "skill"), NO_SERVERS)).toBeNull();
  });
});

describe("deriveCanvasGroups", () => {
  it("gives each agent its own group and several agents a shared one", () => {
    const groups = deriveCanvasGroups(
      [
        node("a1", "agent"),
        node("a2", "agent"),
        node("s1", "sandbox"),
        node("s2", "sandbox"),
        node("s3", "sandbox"),
      ],
      [edge("a1", "s1"), edge("a2", "s2"), edge("a1", "s3"), edge("a2", "s3")],
      NO_SERVERS,
    );

    expect(groups.map((group) => [group.id, group.memberIds])).toEqual([
      ["frame:a1:sandbox:cloud", ["s1"]],
      ["frame:a2:sandbox:cloud", ["s2"]],
      ["frame:a1,a2:sandbox:cloud", ["s3"]],
    ]);
  });

  it("frames a group only once it has a second member", () => {
    const nodes = [
      node("a1", "agent"),
      node("s1", "sandbox"),
      node("s2", "sandbox"),
      node("mac", "sandbox", { config: { provider: "machine" } }),
    ];
    const one = [edge("a1", "s1"), edge("a1", "mac")];
    const two = [...one, edge("a1", "s2")];

    expect(framesOf(deriveCanvasGroups(nodes, one, NO_SERVERS))).toEqual([]);
    expect(
      framesOf(deriveCanvasGroups(nodes, two, NO_SERVERS)).map(
        (frame) => frame.memberIds,
      ),
    ).toEqual([["s1", "s2"]]);
  });

  it("leaves out a node pulled out by hand, and frames what is left", () => {
    const nodes = [
      node("a1", "agent"),
      node("s1", "sandbox"),
      node("s2", "sandbox"),
      node("s3", "sandbox", { ungrouped: true }),
    ];
    const edges = [edge("a1", "s1"), edge("a1", "s2"), edge("a1", "s3")];

    expect(
      framesOf(deriveCanvasGroups(nodes, edges, NO_SERVERS)).map(
        (frame) => frame.memberIds,
      ),
    ).toEqual([["s1", "s2"]]);
  });

  it("puts members where a drop left them, and the rest after", () => {
    const nodes = [
      node("a1", "agent"),
      node("w1", "workspace", { frameOrder: 2 }),
      node("w2", "workspace", { frameOrder: 0 }),
      node("w3", "workspace", { frameOrder: 1 }),
      // Joined after the drop, so no slot of its own: it sorts last.
      node("w4", "workspace"),
    ];
    const edges = [
      edge("a1", "w1"),
      edge("a1", "w2"),
      edge("a1", "w3"),
      edge("a1", "w4"),
    ];

    expect(
      framesOf(deriveCanvasGroups(nodes, edges, NO_SERVERS)).map(
        (frame) => frame.memberIds,
      ),
    ).toEqual([["w2", "w3", "w1", "w4"]]);
  });

  it("leaves unreached resources ungrouped, and groups a mounted sandbox with its agent", () => {
    const frames = deriveCanvasGroups(
      [
        node("a1", "agent"),
        node("w1", "workspace"),
        node("s1", "sandbox"),
        node("s2", "sandbox"),
      ],
      [
        edge("a1", "w1"),
        { id: "mount:w1-left-s1-right", source: "w1", target: "s1" },
      ],
      NO_SERVERS,
    );

    expect(frames.flatMap((frame) => frame.memberIds).sort()).toEqual([
      "s1",
      "w1",
    ]);
  });

  it("orders sandbox members and frames by their place in sandboxes", () => {
    const nodes = [
      node("a1", "agent", { sandboxOrder: ["mac", "cloud-b", "cloud-a"] }),
      node("cloud-a", "sandbox"),
      node("cloud-b", "sandbox"),
      node("mac", "sandbox", { config: { provider: "machine" } }),
    ];
    const edges = [
      edge("a1", "cloud-a"),
      edge("a1", "cloud-b"),
      edge("a1", "mac"),
    ];

    expect(
      deriveCanvasGroups(nodes, edges, NO_SERVERS).map(
        (frame) => frame.memberIds,
      ),
    ).toEqual([["mac"], ["cloud-b", "cloud-a"]]);
    expect(sandboxOrderNumbers(nodes, edges)).toEqual(
      new Map([
        ["mac", 1],
        ["cloud-b", 2],
        ["cloud-a", 3],
      ]),
    );
  });
});

describe("machine MCP members", () => {
  it("line up with the order of the computers they run on", () => {
    const nodes = [
      node("a1", "agent", { sandboxOrder: ["phicks", "kien"] }),
      node("kien", "sandbox", { config: { provider: "machine" } }),
      node("phicks", "sandbox", { config: { provider: "machine" } }),
      node("blender", "mcp"),
      node("photos", "mcp"),
    ];
    const edges = [
      edge("a1", "kien"),
      edge("a1", "phicks"),
      edge("a1", "blender"),
      edge("a1", "photos"),
    ];
    const servers: McpServersByNode = new Map([
      ["blender", { sandbox: "kien", transport: "machine" }],
      ["photos", { sandbox: "phicks", transport: "machine" }],
    ]);
    const frames = framesOf(deriveCanvasGroups(nodes, edges, servers));

    expect(frames.map((frame) => frame.memberIds)).toEqual([
      ["phicks", "kien"],
      ["photos", "blender"],
    ]);
  });
});

describe("frame geometry", () => {
  it("round-trips a frame origin through its member slots", () => {
    const origin = { x: 432, y: 288 };
    const frame = { kind: "sandbox" as const, memberIds: ["s1", "s2", "s3"] };
    const slots = frameMemberPositions(origin, frame);

    expect(slots.get("s2")).toEqual({ x: 440, y: 368 });
    expect(frameOriginOf([...slots.values()])).toEqual(origin);
    expect(frameSize(frame)).toEqual({ height: 184, width: 192 });
  });

  it("gives the open chip a card's slot and pushes the ones under it down", () => {
    const frame = { kind: "sandbox" as const, memberIds: ["s1", "s2", "s3"] };
    const slots = frameMemberPositions({ x: 0, y: 0 }, frame, "s1");

    expect([...slots.values()].map((slot) => slot.y)).toEqual([28, 132, 184]);
    expect(frameSize(frame, "s1").height).toEqual(236);
    expect(frameSize(frame, "missing")).toEqual(frameSize(frame));
  });

  it("gives every kind the same slot height", () => {
    const frame = { kind: "workspace" as const, memberIds: ["w1", "w2"] };

    expect(frameMemberPositions({ x: 0, y: 0 }, frame).get("w2")).toEqual({
      x: 8,
      y: 80,
    });
    expect(frameSize(frame)).toEqual({ height: 132, width: 192 });
  });
});

describe("workspaceSandboxIds", () => {
  it("reads a mount, a read-only flag, and otherwise the agent's default", () => {
    const nodes = [
      node("a1", "agent", { sandboxOrder: ["s2", "s1"] }),
      node("s1", "sandbox"),
      node("s2", "sandbox"),
      node("w1", "workspace"),
      node("w2", "workspace"),
      node("w3", "workspace", { readOnly: true }),
    ];
    const edges = [
      edge("a1", "s1"),
      edge("a1", "s2"),
      edge("a1", "w1"),
      edge("a1", "w2"),
      edge("a1", "w3"),
      { id: "mount:w2-left-s1-right", source: "w2", target: "s1" },
    ];

    expect([...workspaceSandboxIds(nodes, edges)]).toEqual([
      ["w1", { kind: "inherited", sandboxIds: ["s2"] }],
      ["w2", { kind: "override", sandboxIds: ["s1"] }],
      ["w3", { kind: "readonly" }],
    ]);
  });

  it("lists each wired agent's own default when agents differ", () => {
    const nodes = [
      node("a1", "agent"),
      node("a2", "agent"),
      node("s1", "sandbox"),
      node("s2", "sandbox"),
      node("w1", "workspace"),
    ];
    const edges = [
      edge("a2", "s2"),
      edge("a1", "s1"),
      edge("a2", "w1"),
      edge("a1", "w1"),
    ];

    expect(workspaceSandboxIds(nodes, edges).get("w1")).toEqual({
      kind: "inherited",
      sandboxIds: ["s1", "s2"],
    });
  });
});

describe("agentRefCounts", () => {
  it("counts agents by sandboxes, workspaces and the sandboxes those mount", () => {
    const nodes = [
      node("a1", "agent"),
      node("a2", "agent"),
      node("s1", "sandbox"),
      node("w1", "workspace"),
    ];
    const edges = [
      edge("a1", "s1"),
      edge("a1", "w1"),
      edge("a2", "w1"),
      { id: "mount:w1-left-s1-right", source: "w1", target: "s1" },
    ];

    expect(agentRefCounts(nodes, edges)).toEqual(
      new Map([
        ["s1", 2],
        ["w1", 2],
      ]),
    );
  });
});

describe("runsOnSandboxIds", () => {
  it("finds a machine server's sandbox by mount name or label", () => {
    const nodes = [
      node("mac", "sandbox", { mountName: "kien-mac" }),
      node("m1", "mcp"),
      node("m2", "mcp"),
    ];
    const servers: McpServersByNode = new Map([
      ["m1", { sandbox: "kien-mac", transport: "machine" }],
      ["m2", { sandbox: null, transport: "http" }],
    ]);

    expect([...runsOnSandboxIds(nodes, servers)]).toEqual([["m1", "mac"]]);
  });
});

describe("agreedSandboxOrderNumbers", () => {
  it("numbers a shared sandbox only when its agents order it the same", () => {
    // bravo is second for `agent` and first, alone, for `second`.
    const nodes = [
      node("agent", "agent"),
      node("second", "agent"),
      node("alpha", "sandbox"),
      node("bravo", "sandbox"),
    ];
    const edges = [
      edge("agent", "alpha"),
      edge("agent", "bravo"),
      edge("second", "bravo"),
    ];

    expect([...agreedSandboxOrderNumbers(nodes, edges)]).toEqual([
      ["alpha", 1],
    ]);
  });

  it("leaves an agent's only sandbox unnumbered", () => {
    const nodes = [node("solo", "agent"), node("lambda", "sandbox")];

    expect([
      ...agreedSandboxOrderNumbers(nodes, [edge("solo", "lambda")]),
    ]).toEqual([]);
  });
});

describe("workspaceOnlySandboxIds", () => {
  it("marks a sandbox a workspace mounts only when no agent wires it", () => {
    // browser backs notes and no agent lists it; alpha backs notes and is listed.
    const nodes = [
      node("agent", "agent"),
      node("alpha", "sandbox"),
      node("browser", "sandbox"),
      node("notes", "workspace"),
    ];
    const edges = [
      edge("agent", "alpha"),
      edge("agent", "notes"),
      {
        id: "mount:alpha-right-notes-left",
        source: "alpha",
        target: "notes",
        type: "mount",
      },
      {
        id: "mount:browser-right-notes-left",
        source: "browser",
        target: "notes",
        type: "mount",
      },
    ];

    expect([...workspaceOnlySandboxIds(nodes, edges)]).toEqual(["browser"]);
  });
});
