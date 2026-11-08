import { describe, expect, test } from "bun:test";

import {
  createAiSdkHarnessAdapter,
  createConfiguredAiSdkHarnessAdapter,
  type AiSdkHarnessType,
} from "../../../../apps/core/src/harness/ai-sdk-harness/adapters/index.ts";
import { requireAiSdkHarnessCompute } from "../../../../apps/core/src/harness/ai-sdk-harness/sandbox.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";

type Compute = Parameters<typeof requireAiSdkHarnessCompute>[0];

const HARNESS_TYPES: AiSdkHarnessType[] = [
  "claude-code",
  "codex",
  "deepagents",
  "opencode",
  "pi",
];

function configFor(type: AiSdkHarnessType): AgentConfig {
  return {
    harness: { type: type },
    model: { provider: "anthropic", modelId: "claude-haiku-5-5" },
    provider: {
      anthropic: { apiKey: "test-key" },
      openai: { apiKey: "test-key" },
    },
  } as unknown as AgentConfig;
}

describe("harness adapters", () => {
  test.each(HARNESS_TYPES)("creates a %s adapter", (type): void => {
    expect(createAiSdkHarnessAdapter(type)).toBeDefined();
  });

  test.each(HARNESS_TYPES)(
    "builds a configured %s adapter or refuses it",
    (type): void => {
      try {
        expect(
          createConfiguredAiSdkHarnessAdapter(configFor(type)),
        ).toBeDefined();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    },
  );
});

describe("requireAiSdkHarnessCompute", () => {
  test.each([
    { provider: "sandbox", persistent: true },
    { provider: "lambda", persistent: true },
  ])("accepts $provider", (compute): void => {
    expect(requireAiSdkHarnessCompute(compute as Compute)).toBe(
      compute as Compute,
    );
  });

  test.each([
    { provider: "sandbox", persistent: false },
    { provider: "lambda" },
    { provider: "cloudflare", persistent: true },
  ])("refuses %j", (compute): void => {
    expect(() => requireAiSdkHarnessCompute(compute as Compute)).toThrow(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  });
});
