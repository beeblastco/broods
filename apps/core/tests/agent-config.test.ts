import { describe, expect, it } from "bun:test";
import { toRuntimeAgentConfig } from "../src/shared/domain/agent-config.ts";

// The validation rules themselves are tested with the config plane's copy in
// packages/convex/tests/agentRules.test.ts; these cover what core adds.
describe("agent config runtime", () => {
  // toRuntimeAgentConfig rebuilds from an explicit whitelist; a branch missing
  // there silently never reaches the harness.
  it("keeps mcp and browser in the runtime projection", () => {
    const serverId = "k57mcpserver00000000000000000000";
    const runtime = toRuntimeAgentConfig({
      model: { provider: "vertex", modelId: "gemini-3.7-flash" },
      mcp: { [serverId]: { enabled: true } },
      browser: { enabled: true },
    });
    expect(runtime.mcp).toEqual({ [serverId]: { enabled: true } });
    expect(runtime.browser).toEqual({ enabled: true });
  });

  it("refuses a stored config that still carries the removed sandbox key", () => {
    // Dropping the key would quietly make sb_b the default.
    const stored = { sandbox: "sb_a", sandboxes: ["sb_b"] };

    expect(() => toRuntimeAgentConfig(stored)).toThrow(
      "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default",
    );
  });
});
