import { describe, expect, test } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import {
  analyzeCanvasInfra,
  deriveSubagentRefs,
} from "../app/lib/canvasRuntimeRefs";

/** Minimal canvas node; `data` carries the same fields BaseNode reads. */
function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): Node {
  return {
    id: id,
    type: type,
    position: { x: 0, y: 0 },
    data: { label: id, ...data },
  } as Node;
}

function edge(source: string, target: string, type?: string): Edge {
  return {
    id: `${source}->${target}`,
    source: source,
    target: target,
    ...(type ? { type: type } : {}),
  } as Edge;
}

describe("analyzeCanvasInfra workspace state", () => {
  test("CLI readOnly flag forces read-only even with an agent default sandbox", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox"),
      node("ws", "workspace", { readOnly: true }),
    ];
    const edges = [edge("agent", "sb"), edge("agent", "ws")];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.ws).toEqual({ kind: "readonly" });
  });

  test("a writable mount edge wins over the readOnly flag (shared-writable)", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox"),
      node("ws", "workspace", { readOnly: true }),
    ];
    // Mount edge ws<->sb means another agent can write here.
    const edges = [edge("agent", "ws"), edge("ws", "sb")];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.ws.kind).toBe("override");
  });

  test("no flag + agent default sandbox => inherited (writable)", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("sb", "sandbox"),
      node("ws", "workspace"),
    ];
    const edges = [edge("agent", "sb"), edge("agent", "ws")];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.ws.kind).toBe("inherited");
  });

  test("override demo topology: scratch=inherited, secure=override, reference=readonly", () => {
    const nodes = [
      node("agent", "agent", { agentConfigId: "cfg" }),
      node("default-sandbox", "sandbox"),
      node("secure-sandbox", "sandbox"),
      node("scratch", "workspace", { readOnly: false }),
      node("secure", "workspace", { readOnly: false }),
      node("reference", "workspace", { readOnly: true }),
    ];
    const edges = [
      edge("agent", "default-sandbox"),
      edge("agent", "scratch"),
      edge("agent", "secure"),
      edge("secure", "secure-sandbox"),
      edge("agent", "reference"),
    ];

    const { workspaceStates } = analyzeCanvasInfra(nodes, edges);

    expect(workspaceStates.scratch.kind).toBe("inherited");
    expect(workspaceStates.secure.kind).toBe("override");
    expect(workspaceStates.reference).toEqual({ kind: "readonly" });
  });
});

describe("deriveSubagentRefs", () => {
  test("a subagent edge adds the target's config id to the source's callees", () => {
    const nodes = [
      node("parent", "agent", { agentConfigId: "cfg_parent" }),
      node("child", "agent", { agentConfigId: "cfg_child" }),
    ];
    const edges = [edge("parent", "child", "subagent")];

    const refs = deriveSubagentRefs(nodes, edges);
    const parent = refs.find((r) => r.configId === ("cfg_parent" as never));
    const child = refs.find((r) => r.configId === ("cfg_child" as never));

    expect(parent?.calleeConfigIds).toEqual(["cfg_child" as never]);
    expect(child?.calleeConfigIds).toEqual([]);
  });

  test("non-subagent edges are ignored", () => {
    const nodes = [
      node("parent", "agent", { agentConfigId: "cfg_parent" }),
      node("child", "agent", { agentConfigId: "cfg_child" }),
    ];
    const edges = [edge("parent", "child", "default")];

    const refs = deriveSubagentRefs(nodes, edges);
    const parent = refs.find((r) => r.configId === ("cfg_parent" as never));

    expect(parent?.calleeConfigIds).toEqual([]);
  });
});
