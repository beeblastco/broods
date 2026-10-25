/**
 * Shared token pricing and provider metadata conventions for usage metering.
 * Rates are standard USD prices per million text tokens, crawled hourly from
 * models.dev into the `modelPrices` table (`modelPrices/crawl.ts`).
 */

/** Provider metadata fields that report cache creation tokens. */
export const PROVIDER_CACHE_WRITE_FIELDS: Readonly<Record<string, string>> = {
  anthropic: "cacheCreationInputTokens",
  bedrock: "cacheCreationInputTokens",
  openai: "",
};

/** Cost components for a model whose rates are known. */
export interface ModelCostEstimate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Standard token rates in USD per million tokens. */
export interface ModelTokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Raw token counts used to estimate one model's cost. `inputTokens` is the AI
 * SDK total, so it already includes `cachedInputTokens` and `cacheWriteTokens`.
 */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export function canonicalModelProvider(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized.includes("bedrock")) return "bedrock";
  if (normalized.includes("anthropic")) return "anthropic";
  if (
    normalized.includes("google") ||
    normalized.includes("vertex") ||
    normalized.includes("gemini")
  )
    return "google";
  if (normalized.includes("openai") || normalized.includes("azure"))
    return "openai";

  return normalized;
}

/** Estimate standard token cost; returns null when the model is unpriced. */
export function estimateModelTokenCost(
  rates: ModelTokenRates | undefined,
  usage: ModelTokenUsage,
): ModelCostEstimate | null {
  if (!rates) return null;

  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens,
  );
  const input = (uncachedInput * rates.input) / 1_000_000;
  const output = (usage.outputTokens * rates.output) / 1_000_000;
  const cacheRead = (usage.cachedInputTokens * rates.cacheRead) / 1_000_000;
  const cacheWrite = (usage.cacheWriteTokens * rates.cacheWrite) / 1_000_000;

  return {
    input: input,
    output: output,
    cacheRead: cacheRead,
    cacheWrite: cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

/** The model id rates are stored and looked up by, so `GPT-5.5` finds `gpt-5.5`. */
export function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase();
}

/**
 * The stored ids a usage model id is priced under, most exact first: then
 * without a release date (`-20250514`, `-2025-08-07`), since models.dev often
 * lists a dated snapshot only under its alias.
 */
export function priceLookupIds(modelId: string): string[] {
  const exact = normalizeModelId(modelId);
  const undated = exact.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");

  return undated === exact ? [exact] : [exact, undated];
}
