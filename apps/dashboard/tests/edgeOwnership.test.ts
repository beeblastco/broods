import { describe, expect, test } from "bun:test";
import type { LayoutNode } from "@broods/convex/model/canvasLayout";
import {
  connectionEdge,
  isCodeManagedEdge,
} from "../app/components/canvas/edgeOwnership";

/**
 * Tracy's CLI nodes, an agent the account REST API owns, and resources made on
 * the dashboard.
 */
const NODES: Record<string, LayoutNode> = {
  "agent-dash": node("agent-dash", "agent", "dashboard"),
  "api-agent-ops": node("api-agent-ops", "agent", "api"),
  "cli-agent-tracy": node("cli-agent-tracy", "agent", "cli"),
  "cli-sandbox-mac": node("cli-sandbox-mac", "sandbox", "cli"),
  "cli-workspace-notes": node("cli-workspace-notes", "workspace", "cli"),
  "sandbox-dash": node("sandbox-dash", "sandbox", "dashboard"),
  "workspace-dash": node("workspace-dash", "workspace", "dashboard"),
};

describe("isCodeManagedEdge", () => {
  test("owns an edge a person draws from a code-managed agent, so it can't be drawn", () => {
    for (const [source, target] of [
      ["cli-agent-tracy", "cli-sandbox-mac"],
      ["cli-agent-tracy", "sandbox-dash"],
    ]) {
      expect(owned(source, null, target, "top", true), target).toBe(true);
    }
  });

  test("owns a mount between two code-managed resources", () => {
    expect(
      owned("cli-sandbox-mac", "right", "cli-workspace-notes", "left", false),
    ).toBe(true);
  });

  test("leaves a dashboard agent's edge to a code-managed sandbox to the person who drew it", () => {
    expect(owned("agent-dash", null, "cli-sandbox-mac", "top", true)).toBe(
      false,
    );
  });

  test("owns an API agent's edge, which carries no `cli-` in its id to go by", () => {
    expect(owned("api-agent-ops", null, "sandbox-dash", "top", true)).toBe(
      true,
    );
    expect(
      owned("api-agent-ops", "right", "agent-dash", "left", true),
      "subagent link",
    ).toBe(true);
  });

  test("falls back to the id prefix when the owning end has left the graph", () => {
    expect(
      isCodeManagedEdge(
        {
          id: "xy-edge__cli-agent-tracy-cli-sandbox-mac",
          source: "cli-agent-tracy",
          target: "cli-sandbox-mac",
        },
        () => undefined,
      ),
    ).toBe(true);
  });

  test("reads a mount off its workspace, so dragging it either way says the same", () => {
    expect(
      owned("cli-workspace-notes", "left", "sandbox-dash", "right", false),
      "workspace dragged onto sandbox",
    ).toBe(true);
    expect(
      owned("sandbox-dash", "right", "cli-workspace-notes", "left", false),
      "sandbox dragged onto workspace",
    ).toBe(true);
    // The sandbox end does not decide it: this workspace is editable here.
    expect(
      owned("cli-sandbox-mac", "right", "workspace-dash", "left", false),
    ).toBe(false);
  });
});

describe("connectionEdge", () => {
  test("keeps React Flow's id for a plain edge and encodes side handles in a mount's", () => {
    expect(
      connectionEdge(
        {
          source: "agent-dash",
          sourceHandle: null,
          target: "sandbox-dash",
          targetHandle: "top",
        },
        true,
      ).id,
    ).toBe("xy-edge__agent-dash-sandbox-dashtop");
    expect(
      connectionEdge(
        {
          source: "sandbox-dash",
          sourceHandle: "right",
          target: "cli-workspace-notes",
          targetHandle: "left",
        },
        false,
      ),
    ).toMatchObject({
      id: "mount:sandbox-dash-right-cli-workspace-notes-left",
      type: "mount",
    });
  });
});

function owned(
  source: string,
  sourceHandle: string | null,
  target: string,
  targetHandle: string,
  sourceIsAgent: boolean,
): boolean {
  return isCodeManagedEdge(
    connectionEdge(
      {
        source: source,
        sourceHandle: sourceHandle,
        target: target,
        targetHandle: targetHandle,
      },
      sourceIsAgent,
    ),
    (nodeId) => NODES[nodeId],
  );
}

function node(id: string, type: string, managedBy: string): LayoutNode {
  return { data: { managedBy: managedBy }, id: id, type: type };
}
