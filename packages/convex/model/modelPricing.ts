export const PROVIDER_CACHE_WRITE_FIELDS: Readonly<Record<string, string>> = {
  anthropic: "cacheCreationInputTokens",
  bedrock: "cacheCreationInputTokens",
  openai: "",
};

export interface ModelCostEstimate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** USD per million tokens. */
export interface ModelTokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// `inputTokens` is the AI SDK total: it already includes the cached and cache-write tokens.
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

export function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase();
}

// Then undated (`-20250514`, `-2025-08-07`): models.dev often lists a snapshot only by alias.
export function priceLookupIds(modelId: string): string[] {
  const exact = normalizeModelId(modelId);
  const undated = exact.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");

  return undated === exact ? [exact] : [exact, undated];
}
