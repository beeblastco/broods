import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import * as log from "../src/shared/log.ts";

type Reasoning = NonNullable<AgentConfig["model"]>["reasoning"];

// Each factory hands back its settings, so the adapter's return value is what the harness got.
const echo = (settings: unknown): unknown => settings;
await mock.module("@ai-sdk/harness-pi", (): Record<string, unknown> => ({
  VERSION: "test",
  createPi: echo,
}));
await mock.module("@ai-sdk/harness-codex", (): Record<string, unknown> => ({
  VERSION: "test",
  createCodex: echo,
}));
await mock.module(
  "@ai-sdk/harness-claude-code",
  (): Record<string, unknown> => ({
    VERSION: "test",
    createClaudeCode: echo,
  }),
);
await mock.module(
  "@ai-sdk/harness-deepagents",
  (): Record<string, unknown> => ({
    VERSION: "test",
    createDeepAgents: echo,
  }),
);
await mock.module("@ai-sdk/harness-opencode", (): Record<string, unknown> => ({
  VERSION: "test",
  createOpenCode: echo,
}));

const { createConfiguredPiAdapter } =
  await import("../src/harness/ai-sdk-harness/adapters/pi.ts");
const { createConfiguredCodexAdapter } =
  await import("../src/harness/ai-sdk-harness/adapters/codex.ts");
const { createConfiguredClaudeCodeAdapter } =
  await import("../src/harness/ai-sdk-harness/adapters/claude-code.ts");
const { createConfiguredDeepAgentsAdapter } =
  await import("../src/harness/ai-sdk-harness/adapters/deepagents.ts");
const { createConfiguredOpenCodeAdapter } =
  await import("../src/harness/ai-sdk-harness/adapters/opencode.ts");

describe("harness reasoning settings", (): void => {
  it("gives Pi an explicit level, its default when none is configured", (): void => {
    const level = (reasoning: Reasoning): unknown =>
      (
        createConfiguredPiAdapter(agent("pi", "anthropic", reasoning)) as {
          thinkingLevel?: string;
        }
      ).thinkingLevel;

    expect(level("xhigh")).toBe("xhigh");
    expect(level("none")).toBe("off");
    expect(level("provider-default")).toBe("medium");
    expect(level(undefined)).toBe("medium");
  });

  it("passes Codex every effort it accepts", (): void => {
    const effort = (reasoning: Reasoning): unknown =>
      (
        createConfiguredCodexAdapter(agent("codex", "openai", reasoning)) as {
          reasoningEffort?: string;
        }
      ).reasoningEffort;

    expect(effort("xhigh")).toBe("xhigh");
    expect(effort("minimal")).toBe("low");
    expect(effort("none")).toBeUndefined();
    expect(effort("provider-default")).toBeUndefined();
  });

  it("gives Claude Code and Deep Agents an effort every Claude model accepts", (): void => {
    for (const create of [
      (config: AgentConfig): unknown =>
        createConfiguredClaudeCodeAdapter(config),
      (config: AgentConfig): unknown =>
        createConfiguredDeepAgentsAdapter(config),
    ]) {
      const settings = (reasoning: Reasoning): unknown =>
        create(agent("claude-code", "anthropic", reasoning));

      expect(settings("high")).toMatchObject({ effort: "high" });
      expect(settings("xhigh")).toMatchObject({ effort: "high" });
      expect(settings("minimal")).toMatchObject({ effort: "low" });
      expect(settings("none")).toMatchObject({ effort: "low" });
      expect(settings("none")).not.toHaveProperty("thinking");
      expect(settings("provider-default")).not.toHaveProperty("effort");
    }
  });

  it("gives Claude models without effort nothing, as before", (): void => {
    const effortFor = (modelId: string): unknown => {
      const config = agent("claude-code", "anthropic", "high");
      config.model = { ...config.model, modelId: modelId };

      return createConfiguredClaudeCodeAdapter(config);
    };
    for (const modelId of [
      "claude-sonnet-4-5",
      "anthropic/claude-haiku-4.5",
      "claude-opus-4-1",
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-latest",
    ]) {
      expect(effortFor(modelId)).not.toHaveProperty("effort");
    }
    for (const modelId of ["claude-opus-4-5", "claude-sonnet-4-6"]) {
      expect(effortFor(modelId)).toMatchObject({ effort: "high" });
    }
  });

  it("gives OpenCode the nearest variant the model has", (): void => {
    const variant = (
      provider: "anthropic" | "openai" | "vercel",
      modelId: string,
      reasoning: Reasoning,
    ): unknown => {
      const config = agent("opencode", provider, reasoning);
      config.model = { ...config.model, modelId: modelId };

      return (
        createConfiguredOpenCodeAdapter(config) as {
          reasoningVariant?: string;
        }
      ).reasoningVariant;
    };

    expect(variant("anthropic", "claude-opus-5-5", "xhigh")).toBe("xhigh");
    expect(variant("anthropic", "claude-opus-5-5", "minimal")).toBe("low");
    expect(variant("anthropic", "claude-opus-5-5", "none")).toBeUndefined();
    expect(variant("anthropic", "claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(variant("anthropic", "claude-sonnet-4-5", "low")).toBe("high");
    expect(variant("openai", "gpt-5", "minimal")).toBe("minimal");
    expect(variant("openai", "gpt-5", "xhigh")).toBe("high");
    expect(variant("openai", "gpt-5.1", "minimal")).toBe("low");
    expect(variant("openai", "gpt-5.1", "none")).toBe("none");
    expect(variant("openai", "gpt-5.2", "xhigh")).toBe("xhigh");
    expect(variant("openai", "gpt-5-codex", "none")).toBeUndefined();
    expect(variant("openai", "gpt-5-2025-08-07", "minimal")).toBe("minimal");
    expect(variant("openai", "gpt-5.1-codex-max", "xhigh")).toBe("xhigh");
    expect(variant("vercel", "anthropic/claude-opus-4.6", "xhigh")).toBe(
      "high",
    );
    expect(variant("vercel", "google/gemini-3-pro", "medium")).toBe("high");
    expect(variant("vercel", "xai/grok-4", "minimal")).toBe("minimal");
    expect(
      variant("anthropic", "claude-opus-5-5", "provider-default"),
    ).toBeUndefined();
  });

  it("warns in the logs only when a harness runs another level", (): void => {
    const warn = spyOn(log, "logWarn").mockImplementation((): void => {});
    const config = agent("opencode", "anthropic", "xhigh");
    config.model = { ...config.model, modelId: "claude-sonnet-4-6" };
    createConfiguredOpenCodeAdapter(config);
    createConfiguredCodexAdapter(agent("codex", "openai", "high"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      eventType: "harness.reasoning_changed",
      configured: "xhigh",
      sent: "high",
    });
    warn.mockRestore();
  });
});

function agent(
  harness: NonNullable<AgentConfig["harness"]>["type"],
  provider: "anthropic" | "openai" | "vercel",
  reasoning: Reasoning,
): AgentConfig {
  return {
    harness: { type: harness },
    model: {
      provider: provider,
      modelId: "claude-opus-5-5",
      ...(reasoning === undefined ? {} : { reasoning: reasoning }),
    },
    provider: { [provider]: { apiKey: "test-key" } },
  };
}
