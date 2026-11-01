import { createHash } from "node:crypto";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createBaseten } from "@ai-sdk/baseten";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createFireworks } from "@ai-sdk/fireworks";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogle } from "@ai-sdk/google";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createGroq } from "@ai-sdk/groq";
import { createHuggingFace } from "@ai-sdk/huggingface";
import { createMiniMax } from "@ai-sdk/minimax";
import { createMistral } from "@ai-sdk/mistral";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity } from "@ai-sdk/perplexity";
import {
  APICallError,
  UnsupportedFunctionalityError,
  type JSONValue,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FilePart,
  type LanguageModelV4Message,
  type LanguageModelV4StreamPart,
  type LanguageModelV4ToolResultOutput,
  type SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createVercel } from "@ai-sdk/vercel";
import { createXai } from "@ai-sdk/xai";
import { createZai } from "@ai-sdk/zai";
import { createLLMGateway } from "@llmgateway/ai-sdk-provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  jsonSchema,
  Output,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type TranscriptionModel,
} from "ai";
import { createOllama, type OllamaProviderSettings } from "ai-sdk-ollama";
import { createWorkersAI } from "workers-ai-provider";
import { isContextLengthError } from "../shared/errors.ts";
import { publicHostFetch } from "../shared/http.ts";
import {
  PROVIDER_ENDPOINT_SETTING,
  type AccountModelProviderName,
} from "@broods/convex/model/modelProviders";
import type {
  AgentConfig,
  AgentModelOutputConfig,
  AgentModelProviderOptions,
  AgentProviderSettings,
} from "../shared/domain/agent-config.ts";
import { logInfo, logWarn } from "../shared/log.ts";
import { unreadableMediaNote } from "../shared/media-types.ts";
import { chatgptFetch, chatgptMiddleware } from "./chatgpt.ts";

// Responses API: a replayed assistant message references the item the provider holds, valid
// only while it resolves with its reasoning item, so these keep reasoning in context.
export const STORED_ITEM_PROVIDERS: ReadonlySet<AccountModelProviderName> =
  new Set(["azure", "openai"]);

// The AI SDK's default 2 retries span ~6s, shorter than a tokens-per-minute window.
const DEFAULT_MODEL_MAX_RETRIES = 5;

const CLOUDFLARE_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

// Ollama's own default is 127.0.0.1, which from core is the container itself.
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";

const GPT_VERSION_PATTERN = /^(?:ft:)?gpt-(\d+)(?:\.(\d+))?(?:[-:]|$)/i;

const CLAUDE_MODEL_PATTERN = /(?:^|\.)claude-/i;

// These options ride the message or part, never the body: where Claude proxies read them.
const CUSTOM_CACHE_PROVIDER = "openaiCompatible";
const CUSTOM_CACHE_FIELD = "cache_control";

// The AI SDK ignores a retry header of 60s or more.
const MAX_RETRY_HEADER_MS = 59_999;

const RATE_LIMIT_WAIT_PATTERN =
  /(?:try again in |"retryDelay":\s*")(\d+(?:\.\d+)?)\s*(ms|s)\b/i;

// `whisper-1`, not `gpt-4o-mini-transcribe`: only it reads the ogg/opus of voice notes.
const PROVIDER_TRANSCRIPTION: Partial<
  Record<AccountModelProviderName, TranscriptionSource>
> = {
  groq: { factory: createGroq, modelId: "whisper-large-v3-turbo" },
  mistral: { factory: createMistral, modelId: "voxtral-mini-latest" },
  openai: { factory: createOpenAI, modelId: "whisper-1" },
};

// A stored item past its 30-day window, without its reasoning, or encrypted for another model.
const STALE_STORED_ITEM_PATTERN =
  /without its required (?:'reasoning' item|following item)|Item with id .{0,80}not found|encrypted[_ ]content/i;

const toolImageRefusals = new Set<string>();

type ModelProviderFactory = (settings: never) => ModelProviderInstance;

type CloudflareProviderSettings = Extract<
  Parameters<typeof createWorkersAI>[0],
  { accountId: string }
> & {
  gatewayId?: string;
  headers?: Record<string, string>;
};

type UserPromptPart = Extract<
  LanguageModelV4Message,
  { role: "user" }
>["content"][number];

interface ModelProviderInstance {
  (modelId: string): Exclude<LanguageModel, string>;
}

interface TranscriptionSource {
  factory: (settings: never) => {
    transcription: (modelId: string) => Exclude<TranscriptionModel, string>;
  };
  modelId: string;
}

export interface ResolvedModelProvider {
  providerName: AccountModelProviderName;
  provider: ModelProviderInstance;
  model: Exclude<LanguageModel, string>;
}

export type ModelOutputSpec =
  | ReturnType<typeof Output.object>
  | ReturnType<typeof Output.array>
  | ReturnType<typeof Output.choice>
  | ReturnType<typeof Output.json>;

// Built per call so each factory is read off its live binding, keeping it mockable.
export function modelProviderFactories(): Record<
  Exclude<AccountModelProviderName, "chatgpt">,
  ModelProviderFactory
> {
  return {
    alibaba: createAlibaba,
    anthropic: createAnthropic,
    azure: createAzure,
    baseten: createBaseten,
    bedrock: createAmazonBedrock,
    cerebras: createCerebras,
    cloudflare: createCloudflare,
    cohere: createCohere,
    custom: createOpenAICompatible,
    deepinfra: createDeepInfra,
    deepseek: createDeepSeek,
    fireworks: createFireworks,
    google: createGoogle,
    groq: createGroq,
    huggingface: createHuggingFace,
    llmgateway: createLLMGateway,
    minimax: createMiniMax,
    mistral: createMistral,
    moonshotai: createMoonshotAI,
    ollama: (settings: OllamaProviderSettings): ModelProviderInstance =>
      createOllama({
        ...settings,
        baseURL: settings.baseURL?.trim() || OLLAMA_CLOUD_BASE_URL,
      }),
    openai: createOpenAI,
    openrouter: createOpenRouter,
    perplexity: createPerplexity,
    togetherai: createTogetherAI,
    v0: createVercel,
    vercel: createGateway,
    vertex: createGoogleVertex,
    xai: createXai,
    zai: createZai,
  };
}

export function resolveConfiguredModel(
  agentConfig: AgentConfig,
  accountId?: string,
): ResolvedModelProvider {
  const providerName = requireModelProvider(agentConfig);
  const modelId = requireModelId(agentConfig);
  if (providerName === "chatgpt") {
    return resolveChatGPTModel(modelId, accountId);
  }
  const providerConfig = requireProviderSettings(agentConfig, providerName);
  if (providerName === "custom") {
    return resolveOpenAICompatibleModel(providerName, providerConfig, modelId);
  }

  const createProvider = modelProviderFactories()[providerName] as (
    settings: AgentProviderSettings & { fetch?: typeof fetch },
  ) => ModelProviderInstance;
  const provider = createProvider(withModelFetch(providerConfig));
  const model = provider(modelId);

  return {
    providerName: providerName,
    provider: provider,
    model: wrapLanguageModel({
      model: model,
      middleware: [
        dropUnsupportedMediaMiddleware,
        ...(STORED_ITEM_PROVIDERS.has(providerName)
          ? [retryWithoutStoredItemsMiddleware]
          : []),
      ],
    }),
  };
}

export function resolveTranscriptionModel(
  agentConfig: AgentConfig,
): Exclude<TranscriptionModel, string> | undefined {
  const providerName = agentConfig.model?.provider;
  if (!providerName) {
    return undefined;
  }
  const source = PROVIDER_TRANSCRIPTION[providerName];
  if (!source) {
    return undefined;
  }
  try {
    const provider = source.factory(
      withModelFetch(
        requireProviderSettings(agentConfig, providerName),
      ) as never,
    );

    return provider.transcription(
      agentConfig.model?.transcriptionModelId ?? source.modelId,
    );
  } catch {
    return undefined;
  }
}

export function modelSettingsFromModelConfig(
  agentConfig: AgentConfig,
): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    transcriptionModelId: _transcriptionModelId,
    providerOptions: _providerOptions,
    output: _output,
    ...settings
  } = agentConfig.model ?? {};

  return { maxRetries: DEFAULT_MODEL_MAX_RETRIES, ...settings };
}

// A one-shot call like compaction gets no cache defaults: it pays the write, never reads.
export function providerOptionsFromModelConfig(
  agentConfig: AgentConfig,
  conversationKey?: string,
): AgentModelProviderOptions | undefined {
  const configured = agentConfig.model?.providerOptions;
  const providerName = agentConfig.model?.provider;
  if (conversationKey === undefined || providerName === undefined) {
    return configured;
  }
  if (providerName === "anthropic") {
    return withDefaultOption(configured, "anthropic", "cacheControl", {
      type: "ephemeral",
    });
  }
  if (providerName === "custom") {
    return customCacheOptions(agentConfig, conversationKey);
  }
  if (!STORED_ITEM_PROVIDERS.has(providerName) && providerName !== "chatgpt") {
    return configured;
  }

  return withDefaultOption(
    configured,
    "openai",
    "promptCacheKey",
    promptCacheKey(conversationKey),
  );
}

// OpenAI's own breakpoint ends after the live environment no later run resends. Not Azure:
// it reads options under its own name; nor ChatGPT, whose plan documents no such field.
export function cacheBreakpointFromProviderOptions(
  agentConfig: AgentConfig,
  providerOptions: AgentModelProviderOptions | undefined,
): AgentModelProviderOptions | undefined {
  const customCacheControl =
    providerOptions?.[CUSTOM_CACHE_PROVIDER]?.[CUSTOM_CACHE_FIELD];
  if (
    agentConfig.model?.provider === "custom" &&
    customCacheControl !== undefined
  ) {
    return customCacheBreakpoint(customCacheControl);
  }
  if (
    agentConfig.model?.provider === "openai" &&
    providerOptions?.openai?.promptCacheKey !== undefined &&
    takesPromptCacheBreakpoints(agentConfig.model.modelId)
  ) {
    return { openai: { promptCacheBreakpoint: { mode: "explicit" } } };
  }
  const cacheControl = providerOptions?.anthropic?.cacheControl;

  return cacheControl === undefined
    ? undefined
    : { anthropic: { cacheControl: cacheControl } };
}

function takesPromptCacheBreakpoints(modelId: string | undefined): boolean {
  const version = GPT_VERSION_PATTERN.exec(modelId ?? "");
  if (!version) {
    return false;
  }
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);

  return major > 5 || (major === 5 && minor >= 6);
}

export function modelIdentityFromModelConfig(
  agentConfig: AgentConfig,
): string | undefined {
  const providerName = agentConfig.model?.provider;
  const modelId = agentConfig.model?.modelId;
  if (providerName === undefined || modelId === undefined) {
    return undefined;
  }

  return `${providerName}/${modelId}`;
}

export function modelOutputFromModelConfig(
  agentConfig: AgentConfig,
): ModelOutputSpec | undefined {
  const output = agentConfig.model?.output;
  if (!output || output.type === "text") {
    return undefined;
  }

  return createModelOutput(output);
}

// vLLM-style templates take one system message; OVH's Qwen answers more with an empty 200.
// A cache mark keeps the run's own system text separate so the stored prefix still caches.
export const mergeSystemMessagesMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }): Promise<LanguageModelV4CallOptions> => {
    const systems = params.prompt.filter(
      (message) => message.role === "system",
    );
    if (systems.length <= 1) return params;
    const storedEnd =
      systems.findLastIndex(
        (message) => message.providerOptions !== undefined,
      ) + 1;
    const groups =
      storedEnd > 0 && storedEnd < systems.length
        ? [systems.slice(0, storedEnd), systems.slice(storedEnd)]
        : [systems];

    return {
      ...params,
      prompt: [
        ...groups.map(mergedSystemMessage),
        ...params.prompt.filter((message) => message.role !== "system"),
      ],
    };
  },
};

// Claude behind a proxy caches only marked blocks, and nothing marks the latest one for it.
export const cacheLatestMessageMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }): Promise<LanguageModelV4CallOptions> => {
    const cacheControl =
      params.providerOptions?.[CUSTOM_CACHE_PROVIDER]?.[CUSTOM_CACHE_FIELD];
    const latest = params.prompt.at(-1);
    if (cacheControl === undefined || latest === undefined) {
      return params;
    }

    return {
      ...params,
      prompt: params.prompt.with(
        -1,
        withLatestPartMarked(latest, customCacheBreakpoint(cacheControl)),
      ),
    };
  },
};

export function markedForCache<
  T extends { providerOptions?: SharedV4ProviderOptions },
>(item: T, breakpoint: SharedV4ProviderOptions): T {
  const providerOptions = { ...item.providerOptions };
  for (const [provider, options] of Object.entries(breakpoint)) {
    providerOptions[provider] = { ...providerOptions[provider], ...options };
  }

  return { ...item, providerOptions: providerOptions };
}

export function withCacheBreakpoint<
  T extends { providerOptions?: SharedV4ProviderOptions },
>(
  items: T[],
  breakpoint: SharedV4ProviderOptions | undefined,
  index: number = items.length - 1,
): T[] {
  const item = items[index];
  if (breakpoint === undefined || item === undefined) {
    return items;
  }

  return items.with(index, markedForCache(item, breakpoint));
}

// vLLM-style endpoints may stream growing snapshots instead of deltas, and report no
// `reasoning_tokens`: estimate the split from the reasoning/text character share.
export const normalizeStreamDeltasMiddleware: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const accumulated = new Map<string, string>();
    const chars = { "reasoning-delta": 0, "text-delta": 0 };

    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >({
          transform: function (part, controller) {
            if (part.type === "reasoning-delta" || part.type === "text-delta") {
              const key = `${part.type}:${part.id}`;
              const previous = accumulated.get(key) ?? "";
              const delta =
                previous && part.delta.startsWith(previous)
                  ? part.delta.slice(previous.length)
                  : part.delta;
              accumulated.set(key, previous + delta);
              chars[part.type] += delta.length;
              if (delta) {
                controller.enqueue(
                  delta === part.delta ? part : { ...part, delta: delta },
                );
              }

              return;
            }

            if (part.type === "finish" && chars["reasoning-delta"] > 0) {
              const output = part.usage.outputTokens;
              if (output.total && !output.reasoning) {
                const reasoning = Math.round(
                  (output.total * chars["reasoning-delta"]) /
                    (chars["reasoning-delta"] + chars["text-delta"]),
                );
                controller.enqueue({
                  ...part,
                  usage: {
                    ...part.usage,
                    outputTokens: {
                      total: output.total,
                      text: output.total - reasoning,
                      reasoning: reasoning,
                    },
                  },
                });

                return;
              }
            }

            controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

export type ModelAttempt = { startedAt: number; error?: string };

export function attemptRecordingMiddleware(
  record: (attempt: ModelAttempt) => void,
  describeError: (error: unknown) => string,
): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream }) => {
      const attempt: ModelAttempt = { startedAt: Date.now() };
      record(attempt);
      try {
        return await doStream();
      } catch (error) {
        attempt.error = describeError(error);
        throw error;
      }
    },
  };
}

// A refused file part fails prompt conversion before any request, so a retry costs no tokens.
export const dropUnsupportedMediaMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutUnsupportedMedia);

// A text-only model behind a custom endpoint answers a picture with a 400.
export const dropRefusedImagesMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutRefusedImages);

export const retryWithoutStoredItemsMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutStaleStoredItems);

// OpenAI's chat API 400s on an image in a tool message, where vLLM-style servers read it.
export function moveRefusedToolImagesMiddleware(
  endpoint: string,
): LanguageModelMiddleware {
  // Also remembered when the move is refused: a model taking no images then pays one retry.
  const retrying = retryingMiddleware(
    withToolImagesMoved,
    (retryError): void => {
      if (retryError === undefined || isRefusedRequest(retryError)) {
        toolImageRefusals.add(endpoint);
      }
    },
  );

  return {
    ...retrying,
    transformParams: async ({
      params,
    }): Promise<LanguageModelV4CallOptions> => ({
      ...params,
      prompt: toolImageRefusals.has(endpoint)
        ? toolImagesAsUserMessages(params.prompt)
        : withTextToolResultsAsText(params.prompt),
    }),
  };
}

// Only correct with the message's reasoning parts dropped: an id without its reasoning is refused.
export function withoutStoredItemId<
  TPart extends { type: string; providerOptions?: SharedV4ProviderOptions },
>(part: TPart): TPart {
  const openaiOptions = part.providerOptions?.openai;
  if (openaiOptions?.itemId === undefined) {
    return part;
  }
  const { itemId: _itemId, ...remaining } = openaiOptions;

  return {
    ...part,
    providerOptions: { ...part.providerOptions, openai: remaining },
  };
}

function retryingMiddleware(
  recover: (
    error: unknown,
    params: LanguageModelV4CallOptions,
  ) => LanguageModelV4CallOptions | undefined,
  retried?: (retryError: unknown) => void,
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, model, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        const retry = recover(error, params);
        if (!retry) {
          throw error;
        }
        try {
          const result = await model.doGenerate(retry);
          retried?.(undefined);

          return result;
        } catch (retryError) {
          retried?.(retryError);
          throw retryError;
        }
      }
    },
    wrapStream: async ({ doStream, model, params }) => {
      try {
        return await doStream();
      } catch (error) {
        const retry = recover(error, params);
        if (!retry) {
          throw error;
        }
        try {
          const result = await model.doStream(retry);
          retried?.(undefined);

          return result;
        } catch (retryError) {
          retried?.(retryError);
          throw retryError;
        }
      }
    },
  };
}

function withoutUnsupportedMedia(
  error: unknown,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions | undefined {
  if (
    !UnsupportedFunctionalityError.isInstance(error) ||
    !carriesUserMedia(params, isDroppableMedia)
  ) {
    return undefined;
  }
  logInfo("Retrying model call without media the provider refused", {
    error: error.message,
  });

  return withoutUserMedia(params, isDroppableMedia);
}

function withoutRefusedImages(
  error: unknown,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions | undefined {
  if (!isRefusedRequest(error)) {
    return undefined;
  }
  const moved = { ...params, prompt: toolImagesAsUserMessages(params.prompt) };
  if (!carriesUserMedia(moved, isImage)) {
    return undefined;
  }
  logWarn("Retrying model call without images the provider refused", {
    url: error.url,
    error: error.message,
  });

  return withoutUserMedia(moved, isImage);
}

function withToolImagesMoved(
  error: unknown,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions | undefined {
  if (!isRefusedRequest(error)) {
    return undefined;
  }
  const prompt = toolImagesAsUserMessages(params.prompt);
  if (prompt.length === params.prompt.length) {
    return undefined;
  }
  logWarn("Retrying model call with tool images in a user message", {
    url: error.url,
    error: error.message,
  });

  return { ...params, prompt: prompt };
}

function carriesUserMedia(
  params: LanguageModelV4CallOptions,
  matches: (part: UserPromptPart) => part is LanguageModelV4FilePart,
): boolean {
  return params.prompt.some(
    (message) => message.role === "user" && message.content.some(matches),
  );
}

function isDroppableMedia(
  part: UserPromptPart,
): part is LanguageModelV4FilePart {
  return part.type === "file" && !part.mediaType.startsWith("image/");
}

function isImage(part: UserPromptPart): part is LanguageModelV4FilePart {
  return part.type === "file" && part.mediaType.startsWith("image/");
}

function isMovableImage(
  item: Extract<
    LanguageModelV4ToolResultOutput,
    { type: "content" }
  >["value"][number],
): item is LanguageModelV4FilePart {
  return (
    item.type === "file" &&
    item.mediaType.startsWith("image/") &&
    (item.data.type === "data" || item.data.type === "url")
  );
}

// A context overflow is a 400 too, and must reach compaction.
function isRefusedRequest(error: unknown): error is APICallError {
  return (
    APICallError.isInstance(error) &&
    error.statusCode === 400 &&
    !isContextLengthError(error.message)
  );
}

function toolImagesAsUserMessages(
  prompt: LanguageModelV4Message[],
): LanguageModelV4Message[] {
  return prompt.flatMap((message): LanguageModelV4Message[] => {
    if (message.role !== "tool") return [message];
    const images: LanguageModelV4FilePart[] = [];
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") {
        return part;
      }
      const value = part.output.value.map((item) => {
        if (!isMovableImage(item)) return item;
        images.push(item);

        return {
          type: "text" as const,
          text: `[image ${images.length} is in the next message]`,
        };
      });

      return { ...part, output: { ...part.output, value: value } };
    });
    if (images.length === 0) return withTextToolResultsAsText([message]);

    return [
      ...withTextToolResultsAsText([{ ...message, content: content }]),
      {
        role: "user",
        content: [
          { type: "text", text: "Images from the tool results above:" },
          ...images,
        ],
      },
    ];
  });
}

// Some endpoints take nothing but a string in a tool message.
function withTextToolResultsAsText(
  prompt: LanguageModelV4Message[],
): LanguageModelV4Message[] {
  return prompt.map((message): LanguageModelV4Message => {
    if (message.role !== "tool") return message;

    return {
      ...message,
      content: message.content.map((part) => {
        if (
          part.type !== "tool-result" ||
          part.output.type !== "content" ||
          !part.output.value.every((item) => item.type === "text")
        ) {
          return part;
        }
        const text = part.output.value
          .map((item) => (item.type === "text" ? item.text : ""))
          .join("\n");

        return { ...part, output: { type: "text", value: text } };
      }),
    };
  });
}

function withoutUserMedia(
  params: LanguageModelV4CallOptions,
  drop: (part: UserPromptPart) => part is LanguageModelV4FilePart,
): LanguageModelV4CallOptions {
  return {
    ...params,
    prompt: params.prompt.map((message) =>
      message.role !== "user"
        ? message
        : {
            ...message,
            content: message.content.map((part) =>
              drop(part)
                ? {
                    type: "text" as const,
                    text: unreadableMediaNote(part.filename, part.mediaType),
                  }
                : part,
            ),
          },
    ),
  };
}

function withoutStaleStoredItems(
  error: unknown,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions | undefined {
  if (!APICallError.isInstance(error)) {
    return undefined;
  }
  const responseBody =
    typeof error.responseBody === "string" ? error.responseBody : "";
  if (!STALE_STORED_ITEM_PATTERN.test(`${error.message} ${responseBody}`)) {
    return undefined;
  }
  logInfo("Retrying model call without stored item references", {
    error: error.message,
  });

  return withoutStoredItemState(params);
}

function resolveChatGPTModel(
  modelId: string,
  accountId: string | undefined,
): ResolvedModelProvider {
  const provider = createOpenAI({
    apiKey: "chatgpt-connection",
    fetch: chatgptFetch(accountId, withModelFetch({}).fetch),
  });

  return {
    providerName: "chatgpt",
    provider: provider,
    model: wrapLanguageModel({
      model: provider(modelId),
      middleware: [dropUnsupportedMediaMiddleware, chatgptMiddleware],
    }),
  };
}

function resolveOpenAICompatibleModel(
  providerName: "custom",
  providerConfig: AgentProviderSettings,
  modelId: string,
): ResolvedModelProvider {
  const { base_url: _baseUrl, ...openAIConfig } =
    withModelFetch(providerConfig);
  // Not @ai-sdk/openai: only this one parses vLLM's `reasoning`/`reasoning_content` fields.
  const baseURL = customProviderBaseURL(providerConfig) ?? "";
  const provider = createOpenAICompatible({
    supportsMultiPartToolContent: true,
    ...openAIConfig,
    baseURL: baseURL,
    name: customProviderName(providerConfig),
    includeUsage: true,
  });

  return {
    providerName: providerName,
    provider: provider,
    model: wrapLanguageModel({
      model: provider(modelId),
      // Each wraps those after it: a 400 tries the tool image move before the drop, and the
      // cache mark is last so a retry marks its own latest message.
      middleware: [
        mergeSystemMessagesMiddleware,
        normalizeStreamDeltasMiddleware,
        dropRefusedImagesMiddleware,
        moveRefusedToolImagesMiddleware(`${baseURL} ${modelId}`),
        dropUnsupportedMediaMiddleware,
        cacheLatestMessageMiddleware,
      ],
    }),
  };
}

function createCloudflare({
  gatewayId,
  headers,
  ...settings
}: CloudflareProviderSettings): ModelProviderInstance {
  const gateway = gatewayId?.trim();
  if (!gateway) {
    const workersAI = createWorkersAI(settings);

    return (modelId: string): Exclude<LanguageModel, string> =>
      workersAI(workersAIModelId(modelId));
  }
  const gatewayAuth = { "cf-aig-authorization": `Bearer ${settings.apiKey}` };
  const workersAI = createWorkersAI({
    ...settings,
    gateway: { ...settings.gateway, id: gateway },
  });
  const path = [settings.accountId, gateway].map(encodeURIComponent).join("/");
  const compatible = createOpenAICompatible({
    name: "cloudflare",
    baseURL: `${CLOUDFLARE_GATEWAY_BASE_URL}/${path}/compat`,
    headers: { ...headers, ...gatewayAuth },
    fetch: settings.fetch,
    includeUsage: true,
  });

  return (modelId: string): Exclude<LanguageModel, string> => {
    const workersModel = workersAIModelId(modelId);

    return workersModel.startsWith("@")
      ? workersAI(workersModel, { extraHeaders: gatewayAuth })
      : compatible(modelId);
  };
}

function workersAIModelId(modelId: string): string {
  return modelId.replace(/^workers-ai\//, "");
}

// A 429 body's wait as `retry-after-ms`, else the SDK burns its retries before the window resets.
async function withRateLimitRetryHeader(response: Response): Promise<Response> {
  if (
    response.status !== 429 ||
    response.headers.has("retry-after-ms") ||
    response.headers.has("retry-after")
  ) {
    return response;
  }
  const body = await response.text();
  const [, amount, unit] = RATE_LIMIT_WAIT_PATTERN.exec(body) ?? [];
  const headers = new Headers(response.headers);
  if (amount !== undefined && unit !== undefined) {
    const waitMs = Number(amount) * (unit.toLowerCase() === "s" ? 1000 : 1);
    headers.set(
      "retry-after-ms",
      String(Math.min(Math.ceil(waitMs), MAX_RETRY_HEADER_MS)),
    );
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}

// Bun drops a socket silent for 300s, which a busy provider's stream can be; a silent stream
// is aborted by `watchModelStream` instead. A tenant endpoint gets the resolve-then-connect fetch.
function withModelFetch<T extends AgentProviderSettings>(
  settings: T,
): T & { fetch: typeof fetch } {
  const guarded = Object.entries(settings).some(
    ([key, value]) => PROVIDER_ENDPOINT_SETTING.test(key) && Boolean(value),
  );
  const modelFetch = (
    input: string | URL | Request,
    init?: BunFetchRequestInit,
  ): Promise<Response> => {
    const unbounded = { ...init, timeout: false };
    const response = guarded
      ? publicHostFetch(input, unbounded)
      : fetch(input, unbounded);

    return response.then(withRateLimitRetryHeader);
  };

  return { ...settings, fetch: modelFetch as typeof fetch };
}

function requireModelProvider(
  agentConfig: AgentConfig,
): AccountModelProviderName {
  const provider = agentConfig.model?.provider;
  if (!provider) {
    throw new Error("config.model.provider is required");
  }

  return provider;
}

function requireModelId(agentConfig: AgentConfig): string {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required");
  }

  return modelId;
}

function requireProviderSettings(
  agentConfig: AgentConfig,
  providerName: AccountModelProviderName,
): AgentProviderSettings {
  const providerConfig = agentConfig.provider?.[providerName];
  if (!providerConfig) {
    throw new Error(`config.provider.${providerName} is required`);
  }
  if (!providerConfig.apiKey) {
    throw new Error(`config.provider.${providerName}.apiKey is required`);
  }
  if (providerName === "custom" && !customProviderBaseURL(providerConfig)) {
    const hint =
      (providerConfig as Record<string, unknown>).baseUrl !== undefined
        ? ` (found "baseUrl", use "base_url" or "baseURL")`
        : "";
    throw new Error(`config.provider.custom.base_url is required${hint}`);
  }

  return providerConfig;
}

function customCacheBreakpoint(
  cacheControl: JSONValue,
): SharedV4ProviderOptions {
  return { [CUSTOM_CACHE_PROVIDER]: { [CUSTOM_CACHE_FIELD]: cacheControl } };
}

// Any other model gets no cache option: a strict endpoint refuses a field it does not know.
function customCacheOptions(
  agentConfig: AgentConfig,
  conversationKey: string,
): AgentModelProviderOptions | undefined {
  const configured = agentConfig.model?.providerOptions;
  const modelId = servedModelId(agentConfig.model?.modelId);
  if (GPT_VERSION_PATTERN.test(modelId)) {
    return withDefaultOption(
      configured,
      customProviderName(agentConfig.provider?.custom),
      "prompt_cache_key",
      promptCacheKey(conversationKey),
    );
  }
  if (CLAUDE_MODEL_PATTERN.test(modelId)) {
    return withDefaultOption(
      configured,
      CUSTOM_CACHE_PROVIDER,
      CUSTOM_CACHE_FIELD,
      { type: "ephemeral" },
    );
  }

  return configured;
}

function customProviderBaseURL(
  providerConfig: AgentProviderSettings,
): string | undefined {
  const raw =
    typeof providerConfig.base_url === "string"
      ? providerConfig.base_url
      : providerConfig.baseURL;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();

  return trimmed || undefined;
}

function customProviderName(
  providerConfig: AgentProviderSettings | undefined,
): string {
  return typeof providerConfig?.name === "string"
    ? providerConfig.name
    : "custom";
}

function mergedSystemMessage(
  systems: Extract<LanguageModelV4Message, { role: "system" }>[],
): LanguageModelV4Message {
  const providerOptions = systems.at(-1)?.providerOptions;

  return {
    role: "system",
    content: systems.map((message) => message.content).join("\n\n"),
    ...(providerOptions ? { providerOptions: providerOptions } : {}),
  };
}

function promptCacheKey(conversationKey: string): string {
  return createHash("sha256")
    .update(conversationKey)
    .digest("hex")
    .slice(0, 32);
}

function servedModelId(modelId: string | undefined): string {
  return modelId?.split("/").at(-1) ?? "";
}

function withDefaultOption(
  configured: AgentModelProviderOptions | undefined,
  provider: string,
  field: string,
  value: JSONValue,
): AgentModelProviderOptions {
  if (configured?.[provider]?.[field] !== undefined) {
    return configured;
  }

  return {
    ...configured,
    [provider]: { ...configured?.[provider], [field]: value },
  };
}

function withLatestPartMarked(
  message: LanguageModelV4Message,
  breakpoint: SharedV4ProviderOptions,
): LanguageModelV4Message {
  if (message.role === "user") {
    return {
      ...message,
      content: withCacheBreakpoint(message.content, breakpoint),
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: withCacheBreakpoint(
        message.content,
        breakpoint,
        message.content.findLastIndex((part) => part.type === "tool-result"),
      ),
    };
  }

  return markedForCache(message, breakpoint);
}

function createModelOutput(
  output: Exclude<AgentModelOutputConfig, { type: "text" }>,
): ModelOutputSpec {
  switch (output.type) {
    case "object":
      return Output.object({
        schema: jsonSchema(output.schema as never),
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
    case "array":
      return Output.array({
        element: jsonSchema(output.element as never),
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
    case "choice":
      return Output.choice({
        options: output.options,
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
    case "json":
      return Output.json({
        ...(output.name ? { name: output.name } : {}),
        ...(output.description ? { description: output.description } : {}),
      });
  }
}

// A surviving `previousResponseId` would skip the very history this retry sends in full.
function withoutStoredItemState(
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
  const openaiOptions = params.providerOptions?.openai;
  const { previousResponseId: _previousResponseId, ...remainingOptions } =
    openaiOptions ?? {};

  return {
    ...params,
    ...(openaiOptions?.previousResponseId !== undefined
      ? {
          providerOptions: {
            ...params.providerOptions,
            openai: remainingOptions,
          },
        }
      : {}),
    prompt: params.prompt.map((message) =>
      message.role === "assistant"
        ? {
            ...message,
            content: message.content
              .filter((part) => part.type !== "reasoning")
              .map(withoutStoredItemId),
          }
        : message,
    ),
  };
}
