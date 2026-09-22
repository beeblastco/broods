import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import { focusedNodeIds } from "../app/lib/canvasFocus";

/**
 * One agent over two sandboxes and two workspaces: `mounted` overrides onto
 * `cloud`, `wiki` inherits the agent's first sandbox, and `callee` is a
 * subagent with a resource of its own.
 */
const NODES: Node[] = [
  node("agent", "agent", { sandboxOrder: ["cloud", "spare"] }),
  node("callee", "agent"),
  node("cloud", "sandbox"),
  node("spare", "sandbox"),
  node("mounted", "workspace"),
  node("wiki", "workspace"),
  node("calleeKey", "mcp"),
];

const EDGES: Edge[] = [
  edge("agent", "cloud"),
  edge("agent", "spare"),
  edge("agent", "mounted"),
  edge("agent", "wiki"),
  edge("agent", "callee", "subagent"),
  edge("callee", "calleeKey"),
  edge("mounted", "cloud", "mount"),
];

describe("focusedNodeIds", () => {
  // A sandbox carries on to its other workspaces: they share the disk, so the
  // whole mount neighbourhood lights up from any card in it.
  test("a stored mount lights up from either end", () => {
    expect(focusedNodeIds(NODES, EDGES, ["mounted"])).toEqual(
      new Set(["mounted", "cloud", "wiki"]),
    );
    expect(focusedNodeIds(NODES, EDGES, ["cloud"])).toEqual(
      new Set(["cloud", "mounted", "wiki"]),
    );
  });

  test("an inherited mount lights up from either end, with no edge stored", () => {
    expect(focusedNodeIds(NODES, EDGES, ["wiki"])).toEqual(
      new Set(["wiki", "cloud", "mounted"]),
    );
    expect(focusedNodeIds(NODES, EDGES, ["cloud"])).toContain("wiki");
  });

  test("an agent reaches everything it wires, and its callee's own keys do not", () => {
    expect(focusedNodeIds(NODES, EDGES, ["agent"])).toEqual(
      new Set(["agent", "cloud", "spare", "mounted", "wiki", "callee"]),
    );
  });

  test("a resource never lights up the agent wired into it", () => {
    expect(focusedNodeIds(NODES, EDGES, ["calleeKey"])).toEqual(
      new Set(["calleeKey"]),
    );
  });

  test("a frame's members seed the walk together", () => {
    expect(focusedNodeIds(NODES, EDGES, ["cloud", "spare"])).toEqual(
      new Set(["cloud", "spare", "mounted", "wiki"]),
    );
  });
});

function edge(source: string, target: string, type?: string): Edge {
  return {
    id: `${type ?? "default"}:${source}-${target}`,
    source: source,
    target: target,
    type: type,
  };
}

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): Node {
  return {
    data: data,
    id: id,
    position: { x: 0, y: 0 },
    type: type,
  };
}
