import { describe, expect, test } from "bun:test";
import {
  connectionEdge,
  isCodeOwnedEdge,
} from "../app/components/canvas/edgeOwnership";

/** Tracy's CLI nodes, plus a sandbox and an agent made on the dashboard. */
const MANAGED_BY: Record<string, string> = {
  "agent-dash": "dashboard",
  "cli-agent-tracy": "cli",
  "cli-sandbox-mac": "cli",
  "cli-workspace-notes": "cli",
  "sandbox-dash": "dashboard",
};

describe("isCodeOwnedEdge", () => {
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
  return isCodeOwnedEdge(
    connectionEdge(
      {
        source: source,
        sourceHandle: sourceHandle,
        target: target,
        targetHandle: targetHandle,
      },
      sourceIsAgent,
    ),
    (nodeId): unknown => MANAGED_BY[nodeId],
  );
}
