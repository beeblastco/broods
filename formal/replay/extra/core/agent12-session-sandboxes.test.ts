import { describe, expect, test } from "bun:test";
import { Session } from "../../../../apps/core/src/harness/session.ts";

type Runtime = { sandboxes?: unknown[]; workspaces?: unknown[] } | undefined;

// The runtime is resolved through storage and a sandbox provider, so the test sets what it left.
function sessionWith(label: string, runtime: Runtime): Session {
  const session = new Session({
    eventId: `event_${label}`,
    conversationKey: "acct:acct_1:agent:agent_1:api:chat",
    accountId: "acct_1",
    agentId: "agent_1",
  });
  (session as unknown as { resolvedRuntime: Runtime }).resolvedRuntime =
    runtime;

  return session;
}

describe("Session.sandboxes", (): void => {
  test.each<[string, Runtime, unknown[]]>([
    ["no runtime resolved yet", undefined, []],
    ["a runtime with no sandbox key", { workspaces: [] }, []],
    ["an empty list", { sandboxes: [] }, []],
    ["one sandbox", { sandboxes: ["box"] }, ["box"]],
    ["two sandboxes", { sandboxes: ["a", "b"] }, ["a", "b"]],
    ["three sandboxes", { sandboxes: ["a", "b", "c"] }, ["a", "b", "c"]],
    ["numbered sandboxes", { sandboxes: [1, 2] }, [1, 2]],
    ["an empty name", { sandboxes: [""] }, [""]],
    [
      "sandboxes beside workspaces",
      { sandboxes: ["x"], workspaces: ["w"] },
      ["x"],
    ],
    ["workspaces only", { workspaces: ["w1", "w2"] }, []],
    [
      "a long name",
      { sandboxes: ["a-rather-long-sandbox-name"] },
      ["a-rather-long-sandbox-name"],
    ],
    ["repeated names", { sandboxes: ["a", "a"] }, ["a", "a"]],
  ])("%s", (label, runtime, expected): void => {
    expect(
      sessionWith(label.replaceAll(" ", "_"), runtime).sandboxes(),
    ).toEqual(expected);
  });
});
