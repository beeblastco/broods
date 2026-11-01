/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  fromNestedAgentConfig,
  SANDBOX_REMOVED_MESSAGE,
  toNestedAgentConfig,
} from "../model/agentConfigCodec";
import { normalizeAgentConfig } from "../model/agentRules";

describe("agent config codec", () => {
  // `scheduler` has no flat column: it survives a sync only inside extraConfig.
  test("round-trips the scheduler and browser branches", () => {
    const flat = fromNestedAgentConfig({
      model: { provider: "custom", modelId: "deepseek-v4-pro" },
      scheduler: { enabled: true },
      browser: { enabled: true },
    });

    expect(flat.extraConfig).toMatchObject({
      scheduler: { enabled: true },
      browser: { enabled: true },
    });
    expect(toNestedAgentConfig(flat).scheduler).toEqual({ enabled: true });
    expect(toNestedAgentConfig(flat).browser).toEqual({ enabled: true });
  });

  // Without a NESTED_BRANCHES entry the mcp branch is dropped on write.
  test("round-trips the mcp branch", () => {
    const mcp = {
      k57mcpserver00000000000000000000: {
        enabled: true,
        headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
      },
    };
    const flat = fromNestedAgentConfig({
      model: { provider: "custom", modelId: "deepseek-v4-pro" },
      mcp: mcp,
    });

    expect(flat.extraConfig).toMatchObject({ mcp: mcp });
    expect(toNestedAgentConfig(flat).mcp).toEqual(mcp);
  });

  test("round-trips the sandboxes branch", () => {
    const flat = fromNestedAgentConfig({
      model: { provider: "custom", modelId: "deepseek-v4-pro" },
      sandboxes: ["sb_default", "sb_offline"],
    });

    expect(flat.extraConfig).toMatchObject({
      sandboxes: ["sb_default", "sb_offline"],
    });
    expect(toNestedAgentConfig(flat).sandboxes).toEqual([
      "sb_default",
      "sb_offline",
    ]);
  });

  // Dropped, a stored `sandbox` would push a config with no default and no error.
  test("carries a stored legacy sandbox into the nested config", () => {
    const nested = toNestedAgentConfig({
      extraConfig: { sandbox: "sb_default", sandboxes: ["sb_offline"] },
    });

    expect(nested.sandbox).toBe("sb_default");
    expect(() => normalizeAgentConfig(nested)).toThrow(SANDBOX_REMOVED_MESSAGE);
  });

  // Dropped on read, a legacy policy would run the agent ungated.
  test("carries a stored legacy policy into the nested config", () => {
    const nested = toNestedAgentConfig({
      extraConfig: { policy: { policyIds: ["policy_1"] } },
    });

    expect(() => normalizeAgentConfig(nested)).toThrow(
      "config.policy is no longer supported",
    );
  });

  test("rejects the removed sandbox branch", () => {
    expect(() => fromNestedAgentConfig({ sandbox: "sb_default" })).toThrow(
      "config.sandbox was removed; list sandbox ids in config.sandboxes, the first is the default",
    );
  });
});
