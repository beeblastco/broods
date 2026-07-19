/**
 * Per-task token metering helpers. Flattens the AI SDK v7 `LanguageModelUsage`
 * shape (nested input/output token details) for span attributes and usage rows,
 * and meters cache-write tokens with a providerMetadata fallback for providers
 * that only surface cache creation there.
 */

import {
  canonicalModelProvider,
  PROVIDER_CACHE_WRITE_FIELDS,
} from "@broods/convex/modelPricing";
import type { LanguageModelUsage } from "ai";
import { isPlainObject } from "../shared/object.ts";

export interface UsageTokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

// Absent counts read as 0 so span attributes and usage rows stay numeric.
export function usageTokenTotals(
  usage: LanguageModelUsage | undefined,
): UsageTokenTotals {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
}

// Cache-write tokens for one step; 0 when the provider doesn't break them out,
// the field is absent, or metadata is missing. Never throws.
export function extractCacheWriteTokens(
  providerName: string | undefined,
  providerMetadata: Record<string, unknown> | undefined,
): number {
  if (!providerMetadata || !providerName) return 0;

  const provider = canonicalModelProvider(providerName);
  const field = PROVIDER_CACHE_WRITE_FIELDS[provider];
  if (!field) return 0;

  // providerMetadata shape: { [providerKey]: { [fieldName]: value, ... } }
  // The top-level key matches the canonical provider name (e.g. "anthropic").
  const providerBlock = providerMetadata[provider];
  if (isPlainObject(providerBlock)) {
    const val = providerBlock[field];
    if (typeof val === "number" && val > 0) return val;
  }

  // Bedrock wraps the Anthropic block under "anthropic" inside the bedrock block.
  if (provider === "bedrock") {
    const bedrockBlock = providerMetadata["bedrock"];
    if (isPlainObject(bedrockBlock)) {
      const anthropicBlock = bedrockBlock["anthropic"];
      if (isPlainObject(anthropicBlock)) {
        const val = anthropicBlock[field];
        if (typeof val === "number" && val > 0) return val;
      }
      // Also try the field directly on the bedrock block (provider SDK variation).
      const direct = bedrockBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  // Google: usageMetadata lives under the "google" key.
  if (provider === "google") {
    const googleBlock = providerMetadata["google"];
    if (isPlainObject(googleBlock)) {
      const usageMeta = googleBlock["usageMetadata"];
      if (isPlainObject(usageMeta)) {
        const val = usageMeta[field];
        if (typeof val === "number" && val > 0) return val;
      }
      // Also try directly on the google block.
      const direct = googleBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  return 0;
}
