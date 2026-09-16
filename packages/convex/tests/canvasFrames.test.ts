import { describe, expect, it } from "vitest";
import {
  deriveCanvasFrames,
  frameGroupOf,
  frameMemberPositions,
  frameOriginOf,
  frameSize,
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

describe("deriveCanvasFrames", () => {
  it("gives each agent its own frame and several agents a shared one", () => {
    const frames = deriveCanvasFrames(
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

    expect(frames.map((frame) => [frame.id, frame.memberIds])).toEqual([
      ["frame:a1:sandbox:cloud", ["s1"]],
      ["frame:a2:sandbox:cloud", ["s2"]],
      ["frame:a1,a2:sandbox:cloud", ["s3"]],
    ]);
  });

  it("leaves unreached resources unframed, and frames a mounted sandbox with its agent", () => {
    const frames = deriveCanvasFrames(
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
      deriveCanvasFrames(nodes, edges, NO_TRANSPORTS).map(
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
    const slots = frameMemberPositions(origin, ["s1", "s2", "s3"]);

    expect(slots.get("s2")).toEqual({ x: 444, y: 368 });
    expect(frameOriginOf([...slots.values()])).toEqual(origin);
    expect(frameSize(3)).toEqual({ height: 188, width: 174 });
  });
});
