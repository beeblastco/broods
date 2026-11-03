import { describe, expect, it, mock } from "bun:test";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";

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

  it("never sends OpenCode provider-default as a variant", (): void => {
    const variant = (reasoning: Reasoning): unknown =>
      (
        createConfiguredOpenCodeAdapter(
          agent("opencode", "anthropic", reasoning),
        ) as { reasoningVariant?: string }
      ).reasoningVariant;

    expect(variant("high")).toBe("high");
    expect(variant("provider-default")).toBeUndefined();
  });
});

function agent(
  harness: NonNullable<AgentConfig["harness"]>["type"],
  provider: "anthropic" | "openai",
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
