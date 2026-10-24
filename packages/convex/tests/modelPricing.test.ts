import { describe, expect, it } from "vitest";
import {
  canonicalModelProvider,
  estimateModelTokenCost,
  parseModelsDevRates,
} from "../model/modelPricing";

describe("model pricing", () => {
  it("normalizes SDK providers", () => {
    expect(canonicalModelProvider("amazon-bedrock")).toBe("bedrock");
    expect(canonicalModelProvider("google-vertex")).toBe("google");
  });

  it("prices cache reads and writes at their own rate, not the input rate", () => {
    // inputTokens is the SDK total: 1M uncached + 1M cache read + 1M cache write.
    const cost = estimateModelTokenCost(
      { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
      {
        inputTokens: 3_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
    );

    expect(cost).toEqual({
      input: 0.25,
      output: 2,
      cacheRead: 0.025,
      cacheWrite: 0.25,
      total: 2.525,
    });
  });

  it("returns null instead of silently pricing an unknown model", () => {
    expect(
      estimateModelTokenCost(undefined, {
        inputTokens: 100,
        outputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it("keeps mapped models.dev sources, lowercases ids and fills cache rates", () => {
    const sources = parseModelsDevRates({
      "amazon-bedrock": {
        models: {
          "us.anthropic.claude-sonnet-5-5": {
            cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
          },
        },
      },
      openai: {
        models: {
          "GPT-5.5": { cost: { input: 5, output: 30, cache_read: 0.5 } },
          "gpt-image-2": { cost: { input: 5 } },
          "free-preview": {},
        },
      },
      "unmapped-provider": {
        models: { anything: { cost: { input: 1, output: 1 } } },
      },
    });

    expect(sources).toEqual([
      {
        source: "amazon-bedrock",
        models: [
          {
            modelId: "us.anthropic.claude-sonnet-5-5",
            input: 2,
            output: 10,
            cacheRead: 0.1,
            cacheWrite: 2.5,
          },
        ],
      },
      {
        source: "openai",
        models: [
          {
            modelId: "gpt-5.5",
            input: 5,
            output: 30,
            cacheRead: 0.5,
            cacheWrite: 5,
          },
        ],
      },
    ]);
  });
});
