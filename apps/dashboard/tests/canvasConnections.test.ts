import { describe, expect, test } from "bun:test";
import type { Connection, Edge, Node } from "@xyflow/react";
import { connectionRefusal } from "../app/lib/canvasConnections";

/** Two agents, one with a default and a second sandbox, and a workspace mounted on the second. */
const NODES: Node[] = [
  node("coder", "agent", { agentConfigId: "cfg-coder" }),
  node("research", "agent", { agentConfigId: "cfg-research" }),
  node("alpha", "sandbox"),
  node("bravo", "sandbox"),
  node("notes", "workspace"),
];

const EDGES: Edge[] = [
  { id: "e-research-alpha", source: "research", target: "alpha" },
  { id: "e-research-bravo", source: "research", target: "bravo" },
  {
    id: "mount:bravo-right-notes-left",
    source: "bravo",
    sourceHandle: "right",
    target: "notes",
    targetHandle: "left",
    type: "mount",
  },
];

describe("connectionRefusal", () => {
  test("an agent takes a workspace another agent's sandbox backs", () => {
    expect(refusal(connect("coder", "notes"))).toBeNull();
  });

  test("each refusal says why", () => {
    expect(refusal(connect("research", "alpha"))).toBe(
      "research is already connected to alpha.",
    );
    expect(refusal(connect("coder", "notes", "right"))).toStartWith(
      "Side handles link two agents",
    );
    expect(refusal(connect("coder", "research"))).toBe(
      "Link coder to research from side handle to side handle.",
    );
    expect(refusal(connect("alpha", "notes"))).toBe(
      "Mount alpha on notes from side handle to side handle.",
    );
    // bravo is research's second sandbox, so research cannot take its workspace.
    expect(refusal(connect("research", "notes"))).toBe(
      "notes is mounted on bravo, and only an agent's default sandbox can back a workspace.",
    );
  });

  test("code-managed ends are refused as managed through code", () => {
    const managed = NODES.map((item) =>
      item.id === "coder" || item.id === "notes"
        ? { ...item, data: { ...item.data, managedBy: "cli" } }
        : item,
    );

    expect(
      connectionRefusal(
        { edges: EDGES, nodes: managed },
        connect("coder", "notes"),
      ),
    ).toBe("Code manages coder and notes. Add this link there and deploy.");
  });

  test("a CLI agent's edge to a card made here names only the agent", () => {
    const nodes = NODES.map((item) =>
      item.id === "coder"
        ? { ...item, id: "cli-coder", data: { ...item.data, managedBy: "cli" } }
        : item,
    );

    expect(
      connectionRefusal(
        { edges: [], nodes: nodes },
        connect("cli-coder", "notes"),
      ),
    ).toBe("Code manages coder. Add this link there and deploy.");
  });
});

function connect(
  source: string,
  target: string,
  sourceHandle: string | null = null,
): Connection {
  return {
    source: source,
    sourceHandle: sourceHandle,
    target: target,
    targetHandle: "top",
  };
}

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): Node {
  return {
    data: { label: id, ...data },
    id: id,
    position: { x: 0, y: 0 },
    type: type,
  };
}

function refusal(connection: Connection): string | null {
  return connectionRefusal({ edges: EDGES, nodes: NODES }, connection);
}
