/**
 * Per-task cache-write token metering. Cache-write tokens are not in the Vercel
 * AI SDK's normalised usage (cache-READ is, via usage.cachedInputTokens) — they
 * live in per-provider providerMetadata. Only Anthropic, Bedrock (Anthropic),
 * and Google bill for cache creation; OpenAI does not break it out.
 */

import { canonicalModelProvider, PROVIDER_CACHE_WRITE_FIELDS } from "@filthy-panty/convex/modelPricing";

export { PROVIDER_CACHE_WRITE_FIELDS } from "@filthy-panty/convex/modelPricing";

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
  if (isRecord(providerBlock)) {
    const val = providerBlock[field];
    if (typeof val === "number" && val > 0) return val;
  }

  // Bedrock wraps the Anthropic block under "anthropic" inside the bedrock block.
  if (provider === "bedrock") {
    const bedrockBlock = providerMetadata["bedrock"];
    if (isRecord(bedrockBlock)) {
      const anthropicBlock = bedrockBlock["anthropic"];
      if (isRecord(anthropicBlock)) {
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
    if (isRecord(googleBlock)) {
      const usageMeta = googleBlock["usageMetadata"];
      if (isRecord(usageMeta)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
