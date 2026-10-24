/**
 * Shared token pricing and provider metadata conventions for usage metering.
 * Rates are standard USD prices per million text tokens, crawled hourly from
 * models.dev into the `modelPrices` table (`modelPrices/crawl.ts`).
 */

import type { AccountModelProviderName } from "./modelProviders";

/** Where models.dev publishes every provider's models and rates. */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * The models.dev provider that prices each agent provider's model ids, or
 * null when nothing public does: `custom` endpoints and self-hosted `ollama`
 * set their own price, and models.dev has no `v0` rates.
 */
export const MODELS_DEV_SOURCES: Readonly<
  Record<AccountModelProviderName, string | null>
> = {
  alibaba: "alibaba",
  anthropic: "anthropic",
  azure: "azure",
  baseten: "baseten",
  bedrock: "amazon-bedrock",
  cerebras: "cerebras",
  chatgpt: "openai",
  cloudflare: "cloudflare-workers-ai",
  cohere: "cohere",
  custom: null,
  deepinfra: "deepinfra",
  deepseek: "deepseek",
  fireworks: "fireworks-ai",
  google: "google",
  groq: "groq",
  huggingface: "huggingface",
  llmgateway: "llmgateway",
  minimax: "minimax",
  mistral: "mistral",
  moonshotai: "moonshotai",
  ollama: null,
  openai: "openai",
  openrouter: "openrouter",
  perplexity: "perplexity",
  togetherai: "togetherai",
  v0: null,
  vercel: "vercel",
  vertex: "google-vertex",
  xai: "xai",
  zai: "zai",
};

/** Provider metadata fields that report cache creation tokens. */
export const PROVIDER_CACHE_WRITE_FIELDS: Readonly<Record<string, string>> = {
  anthropic: "cacheCreationInputTokens",
  bedrock: "cacheCreationInputTokens",
  google: "cachedContentTokenCount",
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

/** One model's rates as the `modelPrices` table stores them. */
export interface ModelRateRow extends ModelTokenRates {
  modelId: string;
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

/** The slice of models.dev's `api.json` the crawl reads. */
export type ModelsDevApi = Record<
  string,
  {
    models?: Record<
      string,
      {
        cost?: {
          input?: number;
          output?: number;
          cache_read?: number;
          cache_write?: number;
        };
      }
    >;
  }
>;

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

/**
 * The rate rows of every source in `MODELS_DEV_SOURCES`, ids lowercased.
 * A model without an input and output price is skipped; a missing cache rate
 * falls back to the input rate, since the provider gives no discount for it.
 */
export function parseModelsDevRates(
  body: ModelsDevApi,
): Array<{ source: string; models: ModelRateRow[] }> {
  const sources = new Set(
    Object.values(MODELS_DEV_SOURCES).filter((source) => source !== null),
  );

  return [...sources].flatMap((source) => {
    const rows = new Map<string, ModelRateRow>();
    for (const [id, model] of Object.entries(body[source]?.models ?? {})) {
      const cost = model.cost;
      const modelId = id.toLowerCase();
      if (
        typeof cost?.input !== "number" ||
        typeof cost.output !== "number" ||
        rows.has(modelId)
      )
        continue;
      rows.set(modelId, {
        modelId: modelId,
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache_read ?? cost.input,
        cacheWrite: cost.cache_write ?? cost.input,
      });
    }

    return rows.size > 0
      ? [{ source: source, models: [...rows.values()] }]
      : [];
  });
}
