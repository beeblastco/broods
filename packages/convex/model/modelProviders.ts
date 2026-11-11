// Settings naming an endpoint (`baseURL`, `baseUrl`, ...): held to a public https URL.
export const PROVIDER_ENDPOINT_SETTING = /url$/i;

// No image-, speech- or transcription-only providers: they can not back `config.model`.
export const ACCOUNT_MODEL_PROVIDER_NAMES = [
  "alibaba",
  "anthropic",
  "azure",
  "baseten",
  "bedrock",
  "cerebras",
  "chatgpt",
  "cloudflare",
  "cohere",
  "custom",
  "deepinfra",
  "deepseek",
  "fireworks",
  "google",
  "groq",
  "huggingface",
  "llmgateway",
  "minimax",
  "mistral",
  "moonshotai",
  "ollama",
  "openai",
  "openrouter",
  "perplexity",
  "togetherai",
  "v0",
  "vercel",
  "vertex",
  "xai",
  "zai",
] as const;

export type AccountModelProviderName =
  (typeof ACCOUNT_MODEL_PROVIDER_NAMES)[number];

// Every key of `config.provider`: the chat providers, then the speech-to-text only ones.
export const AGENT_PROVIDER_NAMES = [
  ...ACCOUNT_MODEL_PROVIDER_NAMES,
  "fishaudio",
] as const;

export type AgentProviderName = (typeof AGENT_PROVIDER_NAMES)[number];

// Chat providers whose models hear audio themselves, so nothing is transcribed for them.
export const NATIVE_AUDIO_PROVIDER_NAMES: readonly AgentProviderName[] = [
  "google",
  "vertex",
];

// Each provider's default speech-to-text model.
// `whisper-1`, not `gpt-4o-mini-transcribe`: only it reads the ogg/opus of voice notes.
export const TRANSCRIPTION_MODELS = {
  fishaudio: "transcribe-1",
  groq: "whisper-large-v3-turbo",
  mistral: "voxtral-mini-latest",
  openai: "whisper-1",
} as const;

export type TranscriptionProviderName = keyof typeof TRANSCRIPTION_MODELS;

/** Who reads an agent's inbound audio. `native` is the chat model itself. */
export interface AgentVoice {
  provider: AgentProviderName;
  native: boolean;
}

export interface ModelProviderMeta {
  label: string;
  modelPlaceholder: string;
}

export const MODEL_PROVIDERS: Record<
  AccountModelProviderName,
  ModelProviderMeta
> = {
  alibaba: { label: "Alibaba Qwen", modelPlaceholder: "qwen3-max" },
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
  chatgpt: { label: "ChatGPT plan", modelPlaceholder: "gpt-5.5" },
  cloudflare: {
    label: "Cloudflare",
    modelPlaceholder: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
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
  huggingface: {
    label: "Hugging Face",
    modelPlaceholder: "meta-llama/Llama-3.3-70B-Instruct",
  },
  llmgateway: { label: "LLM Gateway", modelPlaceholder: "openai/gpt-4.1-mini" },
  minimax: { label: "MiniMax", modelPlaceholder: "MiniMax-M2.7" },
  mistral: { label: "Mistral", modelPlaceholder: "mistral-large-latest" },
  moonshotai: { label: "Moonshot AI Kimi", modelPlaceholder: "kimi-k2.6" },
  ollama: { label: "Ollama", modelPlaceholder: "gpt-oss:120b" },
  openai: { label: "OpenAI", modelPlaceholder: "gpt-4.1-mini" },
  openrouter: {
    label: "OpenRouter",
    modelPlaceholder: "anthropic/claude-sonnet-4.5",
  },
  perplexity: { label: "Perplexity", modelPlaceholder: "low" },
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
  zai: { label: "Z.ai GLM", modelPlaceholder: "glm-4.7" },
};

// Not `in`: it would accept "constructor" or "__proto__", which have no factory.
export function isAccountModelProviderName(
  value: string,
): value is AccountModelProviderName {
  return Object.hasOwn(MODEL_PROVIDERS, value);
}

/** The provider that reads an agent's voice notes, or null when no one does. */
export function agentVoice(
  modelProvider: string | undefined,
  transcriptionProvider: string | undefined,
): AgentVoice | null {
  if (
    modelProvider !== undefined &&
    isAgentProviderName(modelProvider) &&
    NATIVE_AUDIO_PROVIDER_NAMES.includes(modelProvider)
  ) {
    return { provider: modelProvider, native: true };
  }
  const provider = transcriptionProvider ?? modelProvider;

  return provider !== undefined && isTranscriptionProviderName(provider)
    ? { provider: provider, native: false }
    : null;
}

export function agentProviderLabel(provider: AgentProviderName): string {
  return provider === "fishaudio"
    ? "Fish Audio"
    : MODEL_PROVIDERS[provider].label;
}

export function isAgentProviderName(value: string): value is AgentProviderName {
  return (AGENT_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function isTranscriptionProviderName(
  value: string,
): value is TranscriptionProviderName {
  return Object.hasOwn(TRANSCRIPTION_MODELS, value);
}

export function providerApiKeyEnvName(
  provider: AccountModelProviderName,
): string | null {
  if (provider === "chatgpt") return null;

  return `${provider.toUpperCase()}_API_KEY`;
}
