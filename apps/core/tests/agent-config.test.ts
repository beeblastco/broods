import { describe, expect, it } from "bun:test";
import {
  isChannelTraceEnabled,
  resolveSubagentMode,
  toRuntimeAgentConfig,
} from "../src/shared/domain/agent-config.ts";

// The validation rules themselves are tested with the config plane's copy in
// packages/convex/tests/agentRules.test.ts; these cover what core adds.
describe("agent config runtime", () => {
  // toRuntimeAgentConfig rebuilds from an explicit whitelist; a branch missing
  // there silently never reaches the harness.
  it("keeps mcp in the runtime projection", () => {
    const serverId = "k57mcpserver00000000000000000000";
    const runtime = toRuntimeAgentConfig({
      model: { provider: "vertex", modelId: "gemini-3.7-flash" },
      mcp: { [serverId]: { enabled: true } },
    });
    expect(runtime.mcp).toEqual({ [serverId]: { enabled: true } });
  });

  it("refuses a stored config that still carries the removed sandbox key", () => {
    // Dropping the key would quietly make sb_b the default.
    const stored = { sandbox: "sb_a", sandboxes: ["sb_b"] };

    expect(() => toRuntimeAgentConfig(stored)).toThrow(
      "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default",
    );
  });

  it("appends the trace link only on an explicit enabled", () => {
    expect(isChannelTraceEnabled({}, "zalo")).toBe(false);
    expect(
      isChannelTraceEnabled(
        { channels: { zalo: { trace: "enabled" } } },
        "zalo",
      ),
    ).toBe(true);
    expect(
      isChannelTraceEnabled(
        { channels: { zalo: { trace: "disabled" } } },
        "zalo",
      ),
    ).toBe(false);
  });

  it("defaults subagents to persistent and only opts out on explicit ephemeral", () => {
    expect(resolveSubagentMode({})).toBe("persistent");
    expect(resolveSubagentMode({ subagent: { enabled: true } })).toBe(
      "persistent",
    );
    expect(resolveSubagentMode({ subagent: { mode: "persistent" } })).toBe(
      "persistent",
    );
    expect(resolveSubagentMode({ subagent: { mode: "ephemeral" } })).toBe(
      "ephemeral",
    );
  });
});
