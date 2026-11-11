import { describe, expect, test } from "bun:test";
import type { ProviderMetadata } from "ai";

import { extractCacheWriteTokens } from "../../../../apps/core/src/harness/usage-metering.ts";
import { canonicalModelProvider } from "../../../../packages/convex/model/modelPricing.ts";

describe("extractCacheWriteTokens", (): void => {
  test("reads the field off the provider block", (): void => {
    const metadata: ProviderMetadata = {
      anthropic: { cacheCreationInputTokens: 120 },
    };

    expect(extractCacheWriteTokens("anthropic", metadata)).toBe(120);
  });

  test("reads the nested anthropic block under bedrock", (): void => {
    const metadata: ProviderMetadata = {
      bedrock: { anthropic: { cacheCreationInputTokens: 33 } },
    };

    expect(extractCacheWriteTokens("amazon-bedrock", metadata)).toBe(33);
  });

  test("reads the field set directly on bedrock", (): void => {
    const metadata: ProviderMetadata = {
      bedrock: { cacheCreationInputTokens: 7 },
    };

    expect(extractCacheWriteTokens("bedrock", metadata)).toBe(7);
  });

  test("ignores a zero or non-numeric bedrock value", (): void => {
    const metadata: ProviderMetadata = {
      bedrock: {
        anthropic: { cacheCreationInputTokens: 0 },
        cacheCreationInputTokens: "9",
      },
    };

    expect(extractCacheWriteTokens("bedrock", metadata)).toBe(0);
  });

  test("returns zero for a provider with no cache write field", (): void => {
    expect(extractCacheWriteTokens("mistral", { mistral: {} })).toBe(0);
    expect(extractCacheWriteTokens("azure-openai", { openai: {} })).toBe(0);
  });

  test("returns zero without a provider or metadata", (): void => {
    expect(extractCacheWriteTokens(undefined, { anthropic: {} })).toBe(0);
    expect(extractCacheWriteTokens("anthropic", undefined)).toBe(0);
  });
});

describe("canonicalModelProvider", (): void => {
  test.each<[string, string]>([
    ["Amazon-Bedrock", "bedrock"],
    ["anthropic-vertex", "anthropic"],
    ["Azure", "openai"],
    ["OpenAI-compatible", "openai"],
    ["Gemini", "google"],
    ["Mistral", "mistral"],
  ])("%s is %s", (input: string, expected: string): void => {
    expect(canonicalModelProvider(input)).toBe(expected);
  });
});
