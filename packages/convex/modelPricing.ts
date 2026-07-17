/**
 * Shared token pricing and provider metadata conventions for usage metering.
 * Rates are standard USD prices per million text tokens, reviewed 2026-06-20.
 */

/** Standard token rates in USD per million tokens. */
export interface ModelTokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Raw token counts used to estimate one model's cost. */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/** Cost components for a model whose rates are known. */
export interface ModelCostEstimate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Provider metadata fields that report cache creation tokens. */
export const PROVIDER_CACHE_WRITE_FIELDS: Readonly<Record<string, string>> = {
  anthropic: "cacheCreationInputTokens",
  bedrock: "cacheCreationInputTokens",
  google: "cachedContentTokenCount",
  openai: "",
};

const OPENAI_RATES: ReadonlyArray<[RegExp, ModelTokenRates]> = [
  [/^gpt-5\.5(?:-|$)/, { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 }],
  [
    /^gpt-5\.4-mini(?:-|$)/,
    { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 4.5 },
  ],
  [
    /^gpt-5\.4(?:-|$)/,
    { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15 },
  ],
  [
    /^gpt-5-mini(?:-|$)/,
    { input: 0.25, cacheRead: 0.025, cacheWrite: 0.25, output: 2 },
  ],
  [
    /^gpt-4\.1-mini(?:-|$)/,
    { input: 0.4, cacheRead: 0.1, cacheWrite: 0.4, output: 1.6 },
  ],
];

const ANTHROPIC_RATES: ReadonlyArray<[RegExp, ModelTokenRates]> = [
  [
    /claude-(?:sonnet-4(?:-|$)|sonnet-4-[56])/,
    { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  ],
  [
    /claude-haiku-4-5/,
    { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  ],
  [
    /claude-opus-4-[56]/,
    { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  ],
];

const GOOGLE_RATES: ReadonlyArray<[RegExp, ModelTokenRates]> = [
  [
    /^gemini-2\.5-flash-lite(?:-|$)/,
    { input: 0.1, cacheRead: 0.01, cacheWrite: 0.1, output: 0.4 },
  ],
  [
    /^gemini-2\.5-flash(?:-|$)/,
    { input: 0.3, cacheRead: 0.03, cacheWrite: 0.3, output: 2.5 },
  ],
];

const BEDROCK_RATES: ReadonlyArray<[RegExp, ModelTokenRates]> = [
  ...ANTHROPIC_RATES,
  [
    /amazon\.nova-lite-v1(?::0)?$/,
    { input: 0.06, cacheRead: 0.015, cacheWrite: 0.075, output: 0.24 },
  ],
];

/** Normalize SDK provider names to the pricing and metadata namespaces. */
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

/** Resolve standard token rates for a configured provider/model pair. */
export function resolveModelTokenRates(
  provider: string,
  modelId: string,
): ModelTokenRates | null {
  let normalizedProvider = canonicalModelProvider(provider);
  let normalizedModel = modelId.toLowerCase();
  if (normalizedProvider === "gateway" && normalizedModel.includes("/")) {
    const separator = normalizedModel.indexOf("/");
    normalizedProvider = canonicalModelProvider(
      normalizedModel.slice(0, separator),
    );
    normalizedModel = normalizedModel.slice(separator + 1);
  }

  const tables: Readonly<
    Record<string, ReadonlyArray<[RegExp, ModelTokenRates]>>
  > = {
    openai: OPENAI_RATES,
    anthropic: ANTHROPIC_RATES,
    google: GOOGLE_RATES,
    bedrock: BEDROCK_RATES,
  };
  const match = tables[normalizedProvider]?.find(([pattern]) =>
    pattern.test(normalizedModel),
  );

  return match?.[1] ?? null;
}

/** Estimate standard token cost; returns null when the configured model is unpriced. */
export function estimateModelTokenCost(
  provider: string,
  modelId: string,
  usage: ModelTokenUsage,
): ModelCostEstimate | null {
  const rates = resolveModelTokenRates(provider, modelId);
  if (!rates) return null;

  const input = (usage.inputTokens * rates.input) / 1_000_000;
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
