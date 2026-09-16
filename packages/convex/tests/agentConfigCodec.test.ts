/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  fromNestedAgentConfig,
  SANDBOX_REMOVED_MESSAGE,
  toNestedAgentConfig,
} from "../model/agentConfigCodec";
import { normalizeAgentConfig } from "../model/agentRules";

describe("agent config codec", () => {
  // `scheduler` has no flat column, so it only survives a sync by riding in
  // extraConfig. Dropping it let `broods dev` report the agent as updated while
  // the harness kept building its toolset without schedule_task.
  test("round-trips the scheduler branch", () => {
    const flat = fromNestedAgentConfig({
      model: { provider: "custom", modelId: "deepseek-v4-pro" },
      scheduler: { enabled: true },
    });

    expect(flat.extraConfig).toMatchObject({ scheduler: { enabled: true } });
    expect(toNestedAgentConfig(flat).scheduler).toEqual({ enabled: true });
  });

  // Same failure mode as scheduler: without a NESTED_BRANCHES entry the
  // mcp branch is dropped on write and never reaches core (#331).
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

  // Sandboxes have no flat column either, so they only reach core through
  // extraConfig.
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

  // Dropping a stored `sandbox` would push a config with no default and no error.
  // Carried, it reaches core, which refuses it by name.
  test("carries a stored legacy sandbox into the nested config", () => {
    const nested = toNestedAgentConfig({
      extraConfig: { sandbox: "sb_default", sandboxes: ["sb_offline"] },
    });

    expect(nested.sandbox).toBe("sb_default");
    expect(() => normalizeAgentConfig(nested)).toThrow(SANDBOX_REMOVED_MESSAGE);
  });

  // A pre-#305 policy dropped on read would run the agent ungated. Carried, the
  // validator refuses it by name.
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
