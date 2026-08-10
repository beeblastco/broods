/**
 * The model providers an agent may name in `config.model.provider`.
 * One plain-data list the Convex runtime, the dashboard and core all read; core
 * pairs each name with its Vercel AI SDK factory in `harness/provider.ts` and a
 * `satisfies` there fails the build if the two ever drift.
 */

/** Display metadata for the dashboard's provider pickers. */
export interface ModelProviderMeta {
  label: string;
  modelPlaceholder: string;
}

/**
 * Every Vercel AI SDK provider that ships language models, plus `custom`
 * (any OpenAI-compatible endpoint) and `minimax`. Image-, speech- and
 * transcription-only providers are deliberately absent: they cannot back
 * `config.model`.
 */
export const MODEL_PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    modelPlaceholder: "claude-sonnet-4-5-20250929",
  },
  azure: { label: "Azure OpenAI", modelPlaceholder: "gpt-4.1-mini" },
  baseten: { label: "Baseten", modelPlaceholder: "deepseek-ai/DeepSeek-V3" },
  bedrock: {
    label: "Amazon Bedrock",
    modelPlaceholder: "anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
  cerebras: { label: "Cerebras", modelPlaceholder: "llama3.1-8b" },
  cohere: { label: "Cohere", modelPlaceholder: "command-a-03-2025" },
  custom: {
    label: "Custom OpenAI-compatible",
    modelPlaceholder: "gpt-oss-120b",
  },
  deepinfra: {
    label: "DeepInfra",
    modelPlaceholder: "deepseek-ai/DeepSeek-V3",
  },
  deepseek: { label: "DeepSeek", modelPlaceholder: "deepseek-chat" },
  fireworks: {
    label: "Fireworks",
    modelPlaceholder: "accounts/fireworks/models/deepseek-v3",
  },
  google: { label: "Google", modelPlaceholder: "gemini-2.5-flash" },
  groq: { label: "Groq", modelPlaceholder: "llama-3.3-70b-versatile" },
  minimax: { label: "MiniMax", modelPlaceholder: "MiniMax-M2.7" },
  mistral: { label: "Mistral", modelPlaceholder: "mistral-large-latest" },
  openai: { label: "OpenAI", modelPlaceholder: "gpt-4.1-mini" },
  perplexity: { label: "Perplexity", modelPlaceholder: "sonar-pro" },
  togetherai: {
    label: "Together.ai",
    modelPlaceholder: "deepseek-ai/DeepSeek-V3",
  },
  v0: { label: "Vercel v0", modelPlaceholder: "v0-1.0-md" },
  vercel: {
    label: "Vercel AI Gateway",
    modelPlaceholder: "openai/gpt-4.1-mini",
  },
  vertex: { label: "Google Vertex AI", modelPlaceholder: "gemini-2.5-flash" },
  xai: { label: "xAI Grok", modelPlaceholder: "grok-4" },
} as const satisfies Record<string, ModelProviderMeta>;

export type AccountModelProviderName = keyof typeof MODEL_PROVIDERS;

export const ACCOUNT_MODEL_PROVIDER_NAMES = Object.keys(
  MODEL_PROVIDERS,
) as AccountModelProviderName[];

export function isAccountModelProviderName(
  value: string,
): value is AccountModelProviderName {
  return value in MODEL_PROVIDERS;
}
