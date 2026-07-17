/** Shared model pricing resolution and token cost tests. */

import { describe, expect, it } from "vitest";
import {
  canonicalModelProvider,
  estimateModelTokenCost,
  resolveModelTokenRates,
} from "../modelPricing.ts";

describe("model pricing", () => {
  it("normalizes SDK providers and resolves gateway model identifiers", () => {
    expect(canonicalModelProvider("amazon-bedrock")).toBe("bedrock");
    expect(canonicalModelProvider("google-vertex")).toBe("google");
    expect(resolveModelTokenRates("gateway", "openai/gpt-5.4")?.input).toBe(
      2.5,
    );
    expect(
      resolveModelTokenRates(
        "bedrock",
        "anthropic.claude-sonnet-4-5-20250929-v1:0",
      )?.cacheWrite,
    ).toBe(3.75);
  });

  it("prices input, output, cache reads, and cache writes independently", () => {
    const cost = estimateModelTokenCost("openai", "gpt-5-mini", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

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
      estimateModelTokenCost("minimax", "MiniMax-M3", {
        inputTokens: 100,
        outputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });
});
