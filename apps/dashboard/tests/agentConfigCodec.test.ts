import { describe, expect, test } from "bun:test";
import {
  applyModelReasoning,
  fromNestedAgentConfig,
  readModelReasoning,
  toNestedAgentConfig,
} from "../app/lib/agentConfigCodec";

describe("agent config codec", () => {
  test("keeps event-shaped agent.system from extraConfig instead of flattening to systemPrompt", () => {
    const system = [
      {
        role: "system",
        content: "Use cached policy.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ];

    expect(
      toNestedAgentConfig({
        systemPrompt: "String shorthand",
        extraConfig: { agent: { system: system } },
      }),
    ).toMatchObject({
      agent: { system: system },
    });
  });

  test("stores non-string agent.system under extraConfig", () => {
    const system = [
      {
        role: "system",
        content: "Use cached policy.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ];

    expect(
      fromNestedAgentConfig({
        agent: { system: system },
      }),
    ).toEqual({
      extraConfig: {
        agent: { system: system },
      },
    });
  });

  test("rejects unsupported config keys instead of dropping them", () => {
    expect(() =>
      toNestedAgentConfig({
        extraConfig: {
          model: { options: { anthropic: { thinking: { type: "enabled" } } } },
        },
      }),
    ).toThrow("config.model.options is not supported");
  });

  test("drops the removed workspace branch on read, rejects it on write", () => {
    expect(
      toNestedAgentConfig({
        extraConfig: {
          workspace: { namespace: "legacy", workspaces: { a: {} } },
          workspaces: [{ name: "notes", workspaceId: "ws_a" }],
        },
      }),
    ).toEqual({ workspaces: [{ name: "notes", workspaceId: "ws_a" }] });

    expect(() =>
      fromNestedAgentConfig({ workspace: { namespace: "legacy" } }),
    ).toThrow("config.workspace is no longer supported");
  });

  test("an old row clears its dead workspace branch on the next save", () => {
    const stale = {
      extraConfig: {
        workspace: { namespace: "legacy" },
        workspaces: [{ name: "notes", workspaceId: "ws_a" }],
        skills: { research: { enabled: true } },
      },
    };
    const saved = fromNestedAgentConfig(toNestedAgentConfig(stale));

    expect(saved.extraConfig).not.toHaveProperty("workspace");
    expect(saved.extraConfig).toEqual({
      workspaces: [{ name: "notes", workspaceId: "ws_a" }],
      skills: { research: { enabled: true } },
    });
  });
});

describe("model reasoning codec", () => {
  test("maps budget tokens to the Anthropic thinking provider option", () => {
    const model = applyModelReasoning({}, "anthropic", { budgetTokens: 4096 });

    expect(model).toEqual({
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
      },
    });
    expect(readModelReasoning(model)).toEqual({ budgetTokens: 4096 });
  });

  test("routes MiniMax budget through the Anthropic-compatible slot", () => {
    const model = applyModelReasoning({}, "minimax", { budgetTokens: 2048 });

    expect(model).toEqual({
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
      },
    });
  });

  test("maps OpenAI effort to reasoningEffort", () => {
    const model = applyModelReasoning({}, "openai", { effort: "high" });

    expect(model).toEqual({
      providerOptions: { openai: { reasoningEffort: "high" } },
    });
    expect(readModelReasoning(model)).toEqual({ effort: "high" });
  });

  test("maps Google budget to thinkingConfig.thinkingBudget", () => {
    const model = applyModelReasoning({}, "google", { budgetTokens: 8192 });

    expect(model).toEqual({
      providerOptions: {
        google: {
          thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
        },
      },
    });
    expect(readModelReasoning(model)).toEqual({ budgetTokens: 8192 });
  });

  test("preserves unrelated provider options", () => {
    const model = applyModelReasoning(
      {
        temperature: 0.3,
        providerOptions: {
          openai: { reasoningEffort: "low", reasoningSummary: "auto" },
        },
      },
      "anthropic",
      { budgetTokens: 1024 },
    );

    expect(model).toEqual({
      temperature: 0.3,
      providerOptions: {
        openai: { reasoningSummary: "auto" },
        anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      },
    });
  });

  test("deep-merges reasoning providerOptions with sibling options from the flat column", () => {
    // Reasoning sits in extraConfig.model.providerOptions, cacheControl in the flat column.
    const nested = toNestedAgentConfig({
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      extraConfig: {
        model: {
          providerOptions: {
            anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
          },
        },
      },
    });

    expect(nested.model).toEqual({
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 4096 },
          cacheControl: { type: "ephemeral" },
        },
      },
    });
  });

  test("toggling reasoning off clears every reasoning key", () => {
    const model = applyModelReasoning(
      {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
        },
      },
      "anthropic",
      {},
    );

    expect(model).toEqual({});
    expect(readModelReasoning(model)).toEqual({});
  });
});
