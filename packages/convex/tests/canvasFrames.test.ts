import { describe, expect, it } from "vitest";
import {
  deriveCanvasGroups,
  frameGroupOf,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  inheritedSandboxIds,
  sandboxOrderNumbers,
  type McpTransportsByNode,
} from "../model/canvasFrames";
import type { LayoutEdge, LayoutNode } from "../model/canvasLayout";

const NO_TRANSPORTS: McpTransportsByNode = new Map();

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
        NO_TRANSPORTS,
      ),
    ).toEqual({ key: "machine", kind: "sandbox", label: "Your computer" });
    expect(
      frameGroupOf(
        node("s2", "sandbox", { config: { provider: "lambda" } }),
        NO_TRANSPORTS,
      ),
    ).toEqual({ key: "cloud", kind: "sandbox", label: "Cloud sandbox" });
  });

  it("groups workspaces by storage provider", () => {
    expect(
      frameGroupOf(
        node("w1", "workspace", { config: { storage: { provider: "s3" } } }),
        NO_TRANSPORTS,
      ),
    ).toEqual({ key: "s3", kind: "workspace", label: "Workspaces · S3" });
  });

  it("groups MCP servers by saved transport, and unsaved ones apart", () => {
    const transports = new Map([["m1", "machine" as const]]);

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

  it("never frames a database or a skill", () => {
    expect(frameGroupOf(node("d1", "database"), NO_TRANSPORTS)).toBeNull();
    expect(frameGroupOf(node("k1", "skill"), NO_TRANSPORTS)).toBeNull();
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
      NO_TRANSPORTS,
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

    expect(framesOf(deriveCanvasGroups(nodes, one, NO_TRANSPORTS))).toEqual([]);
    expect(
      framesOf(deriveCanvasGroups(nodes, two, NO_TRANSPORTS)).map(
        (frame) => frame.memberIds,
      ),
    ).toEqual([["s1", "s2"]]);
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
      NO_TRANSPORTS,
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
      deriveCanvasGroups(nodes, edges, NO_TRANSPORTS).map(
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

describe("frame geometry", () => {
  it("round-trips a frame origin through its member slots", () => {
    const origin = { x: 432, y: 288 };
    const frame = { kind: "sandbox" as const, memberIds: ["s1", "s2", "s3"] };
    const slots = frameMemberPositions(origin, frame);

    expect(slots.get("s2")).toEqual({ x: 440, y: 368 });
    expect(frameOriginOf([...slots.values()])).toEqual(origin);
    expect(frameSize(frame)).toEqual({ height: 184, width: 200 });
  });

  it("gives workspace chips taller slots", () => {
    const frame = { kind: "workspace" as const, memberIds: ["w1", "w2"] };

    expect(frameMemberPositions({ x: 0, y: 0 }, frame).get("w2")).toEqual({
      x: 8,
      y: 96,
    });
    expect(frameSize(frame)).toEqual({ height: 164, width: 200 });
  });
});

describe("inheritedSandboxIds", () => {
  it("maps an unmounted workspace to its agent's default sandbox", () => {
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

    expect([...inheritedSandboxIds(nodes, edges)]).toEqual([["w1", "s2"]]);
  });
});
