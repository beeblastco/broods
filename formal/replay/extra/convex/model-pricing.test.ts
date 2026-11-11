import { describe, expect, test } from "bun:test";
import {
  estimateModelTokenCost,
  normalizeModelId,
  priceLookupIds,
} from "../../../../packages/convex/model/modelPricing.ts";
import {
  isAccountModelProviderName,
  providerApiKeyEnvName,
} from "../../../../packages/convex/model/modelProviders.ts";

const RATES = { input: 3, output: 15, cacheRead: 1, cacheWrite: 4 };

describe("estimateModelTokenCost", (): void => {
  test("no rates means no estimate", (): void => {
    expect(
      estimateModelTokenCost(undefined, {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  test("cached tokens leave the input charge", (): void => {
    expect(
      estimateModelTokenCost(RATES, {
        inputTokens: 4_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toEqual({ input: 6, output: 15, cacheRead: 1, cacheWrite: 4, total: 26 });
  });

  test("uncached input never goes negative", (): void => {
    expect(
      estimateModelTokenCost(RATES, {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 0,
      })?.input,
    ).toBe(0);
  });
});

describe("priceLookupIds", (): void => {
  test.each([
    ["Claude-X-20250514", ["claude-x-20250514", "claude-x"]],
    ["gpt-x-2025-08-07", ["gpt-x-2025-08-07", "gpt-x"]],
    ["GPT-X", ["gpt-x"]],
    ["model-2025", ["model-2025"]],
  ])("%s", (id: string, expected: string[]): void => {
    expect(priceLookupIds(id)).toEqual(expected);
  });

  test("normalizes case", (): void => {
    expect(normalizeModelId("ABC")).toBe("abc");
  });
});

describe("model providers", (): void => {
  test.each([
    ["openai", true],
    ["constructor", false],
    ["__proto__", false],
    ["nope", false],
  ])("%s", (name: string, expected: boolean): void => {
    expect(isAccountModelProviderName(name)).toBe(expected);
  });

  test("env names", (): void => {
    expect(providerApiKeyEnvName("chatgpt")).toBeNull();
    expect(providerApiKeyEnvName("openai")).toBe("OPENAI_API_KEY");
  });
});
