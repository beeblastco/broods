import { describe, expect, it, mock } from "bun:test";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";

type Reasoning = NonNullable<AgentConfig["model"]>["reasoning"];

// Each factory hands back its settings, so the adapter's return value is what the harness got.
const echo = (settings: unknown): unknown => settings;
mock.module("@ai-sdk/harness-pi", () => ({ VERSION: "test", createPi: echo }));
mock.module("@ai-sdk/harness-codex", () => ({
  VERSION: "test",
  createCodex: echo,
}));
mock.module("@ai-sdk/harness-claude-code", () => ({
  VERSION: "test",
  createClaudeCode: echo,
}));
mock.module("@ai-sdk/harness-deepagents", () => ({
  VERSION: "test",
  createDeepAgents: echo,
}));
mock.module("@ai-sdk/harness-opencode", () => ({
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

describe("harness reasoning settings", () => {
  it("gives Pi an explicit level, its default when none is configured", () => {
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

  it("passes Codex every effort it accepts", () => {
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

  it("maps reasoning to effort for Claude Code and Deep Agents, and none to no thinking", () => {
    for (const create of [
      (config: AgentConfig): unknown =>
        createConfiguredClaudeCodeAdapter(config),
      (config: AgentConfig): unknown =>
        createConfiguredDeepAgentsAdapter(config),
    ]) {
      const settings = (reasoning: Reasoning): unknown =>
        create(agent("claude-code", "anthropic", reasoning));

      expect(settings("high")).toMatchObject({ effort: "high" });
      expect(settings("minimal")).toMatchObject({ effort: "low" });
      expect(settings("none")).toMatchObject({
        thinking: { type: "disabled" },
      });
      expect(settings("provider-default")).not.toHaveProperty("effort");
      expect(settings("provider-default")).not.toHaveProperty("thinking");
    }
  });

  it("never sends OpenCode provider-default as a variant", () => {
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
      modelId: "test-model",
      ...(reasoning === undefined ? {} : { reasoning: reasoning }),
    },
    provider: { [provider]: { apiKey: "test-key" } },
  };
}
