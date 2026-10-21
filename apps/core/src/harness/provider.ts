/**
 * Agent-configured provider resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

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

// Providers that answer on OpenAI's Responses API, where a replayed assistant
// message is a reference to the item the provider still holds rather than the
// content itself. That reference is only valid while the item resolves and
// still carries the reasoning item it was produced with, which is why these
// providers keep reasoning in context and get the retry below.
export const STORED_ITEM_PROVIDERS: ReadonlySet<AccountModelProviderName> =
  new Set(["azure", "openai"]);

// Model retries when the agent sets none. The AI SDK's 2 retry for about 6s,
// shorter than a tokens-per-minute window, so one 429 failed the whole run.
const DEFAULT_MODEL_MAX_RETRIES = 5;

// Cloudflare AI Gateway's base URL.
const CLOUDFLARE_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

// Ollama's own default is 127.0.0.1, which from core is the container itself.
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";

// An OpenAI model id's GPT major and minor version, like `gpt-6-luna`,
// `gpt-5.6` or the fine-tune `ft:gpt-6-luna:org::id`.
const GPT_VERSION_PATTERN = /^(?:ft:)?gpt-(\d+)(?:\.(\d+))?(?:[-:]|$)/i;

// A Claude model id, after any router prefix like `cc/`.
const CLAUDE_MODEL_PATTERN = /^claude-/i;

// Where a custom endpoint's Claude cache mark lives: Anthropic's `cache_control`
// on a chat message, the field OpenRouter and LiteLLM read. The compatible
// provider puts `openaiCompatible` options on the message or part they came
// with, and sends none of them as a body field.
const CUSTOM_CACHE_PROVIDER = "openaiCompatible";
const CUSTOM_CACHE_FIELD = "cache_control";

// Longest retry-after-ms the AI SDK honours; it falls back to its own backoff above.
const MAX_RETRY_HEADER_MS = 59_999;

// The wait a 429 body asks for, like OpenAI's "Please try again in 5.248s" or
// Gemini's RetryInfo `"retryDelay": "35s"`.
const RATE_LIMIT_WAIT_PATTERN =
  /(?:try again in |"retryDelay":\s*")(\d+(?:\.\d+)?)\s*(ms|s)\b/i;

/**
 * How inbound audio is read, per provider: the factory that ships speech-to-text
 * and the model to ask it for when the account names none. Providers absent
 * here have none, and `config.model.transcriptionModelId` overrides the id.
 *
 * Defaults pick the widest container support, not the cheapest model:
 * `whisper-1` reads the ogg/opus every voice-note channel sends and
 * `gpt-4o-mini-transcribe` does not.
 *
 * Keyed to the factory rather than to an already-built provider so the compiler
 * checks the method still exists: openai and groq declare `transcription` but
 * not `transcriptionModel`, and a rename would otherwise fail in silence.
 */
const PROVIDER_TRANSCRIPTION: Partial<
  Record<AccountModelProviderName, TranscriptionSource>
> = {
  groq: { factory: createGroq, modelId: "whisper-large-v3-turbo" },
  mistral: { factory: createMistral, modelId: "voxtral-mini-latest" },
  openai: { factory: createOpenAI, modelId: "whisper-1" },
};

// How OpenAI names a reference it cannot honour: the item aged out of its 30-day
// window, it lost the reasoning item it was paired with, or its reasoning was
// encrypted for a different model.
const STALE_STORED_ITEM_PATTERN =
  /without its required (?:'reasoning' item|following item)|Item with id .{0,80}not found|encrypted[_ ]content/i;

// Custom endpoints that refused a tool result's image, by base URL and model id.
// Their later calls move tool images up front instead of paying a 400 a step.
const toolImageRefusals = new Set<string>();

// What every AI SDK provider factory has in common: settings in, callable
// provider out. The settings each one accepts are read off it, never restated.
type ModelProviderFactory = (settings: never) => ModelProviderInstance;

// Workers AI REST credentials, plus the AI Gateway that carries every request
// once it is named.
type CloudflareProviderSettings = Extract<
  Parameters<typeof createWorkersAI>[0],
  { accountId: string }
> & {
  gatewayId?: string;
  headers?: Record<string, string>;
};

// One part of a user message as the provider receives it.
type UserPromptPart = Extract<
  LanguageModelV4Message,
  { role: "user" }
>["content"][number];

interface ModelProviderInstance {
  // Never the string form of `LanguageModel`: a constructed provider hands back
  // a model instance, which is what middleware can wrap.
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
  // Never the string form: every resolver returns a constructed instance, so
  // callers can wrap it in middleware.
  model: Exclude<LanguageModel, string>;
}

export type ModelOutputSpec =
  | ReturnType<typeof Output.object>
  | ReturnType<typeof Output.array>
  | ReturnType<typeof Output.choice>
  | ReturnType<typeof Output.json>;

// Name → AI SDK factory; the return type fails the build if a name has no
// factory. Built per call so each is read off its live binding, keeping it
// mockable.
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

/**
 * The agent's model, ready to wrap. `accountId` is only read by `chatgpt`,
 * whose credential is the account's `chatgpt` connection, not a config setting.
 */
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

  // The registry's value type is a union of factories, so its parameter narrows
  // to an intersection no single provider's settings satisfy. Settings are
  // validated by `normalizeProviderSettings` and passed through verbatim.
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

/**
 * The speech-to-text model to read inbound audio with, or undefined when this
 * account's provider ships none or its config cannot build one. Undefined
 * rather than a throw: a half-configured account should lose its transcript and
 * keep the message it arrived on.
 */
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

/**
 * Prompt-cache defaults for a conversation run: Anthropic gets an ephemeral
 * cacheControl (caching there is opt-in per request; the harness also puts it
 * on the ends of the system prompt and the history), OpenAI (and ChatGPT,
 * where a cached prefix spends less of the plan) a promptCacheKey
 * hashed from the conversation key (prefix routing, required from GPT-5.6 on).
 * A custom endpoint serving a GPT model, like a proxy's `cx/gpt-6-luna`, gets
 * that key as `prompt_cache_key` in the request body; without it a long run
 * lands on a server holding only the shared system prompt every few steps.
 * A call without a conversation, like compaction, gets neither: a one-shot
 * request pays the cache write and never reads it back. Explicit account
 * config wins over both defaults.
 */
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

/**
 * What one prompt cache breakpoint carries in a conversation run, or undefined
 * when the run's model takes none. The harness marks the ends of the stored
 * system prompt and of the history with it: the prefix the next run sends
 * again. OpenAI's own breakpoint only ever ends the latest message, after the
 * live environment no later run sends again, so without this mark each run
 * started with nothing cached to read. Anthropic's is the run's cacheControl.
 * Only `openai` gets the OpenAI mark: Azure reads its options under its own
 * name and a deployment name, and ChatGPT plan usage documents no such field.
 * Claude behind a custom endpoint gets the run's `cache_control`.
 */
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

// Explicit breakpoints start at GPT-5.6, fine-tunes of it included. Earlier
// models cache at intervals of their own and document no breakpoint field.
function takesPromptCacheBreakpoints(modelId: string | undefined): boolean {
  const version = GPT_VERSION_PATTERN.exec(modelId ?? "");
  if (!version) {
    return false;
  }
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);

  return major > 5 || (major === 5 && minor >= 6);
}

/**
 * Which model an agent is configured on right now, as a value that can be
 * stored beside a message and compared later. Undefined only when the config is
 * incomplete, which `resolveConfiguredModel` refuses anyway.
 */
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

// vLLM-style chat templates often accept only a single system message, and
// OVH's Qwen endpoints fail SOFT on extras: HTTP 200 with an immediately-empty
// stream (`data: [DONE]`), which surfaces as "Model returned empty response".
// The harness legitimately sends two (the base prompt + the dynamic context
// snapshot), so fold every system message into one before the request leaves.
export const mergeSystemMessagesMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const systems = params.prompt.filter(
      (message) => message.role === "system",
    );
    if (systems.length <= 1) return params;
    // The stored system prompt's cache mark now ends the one message.
    const marked = systems.findLast(
      (message) => message.providerOptions !== undefined,
    );

    return {
      ...params,
      prompt: [
        {
          role: "system",
          content: systems.map((message) => message.content).join("\n\n"),
          ...(marked ? { providerOptions: marked.providerOptions } : {}),
        },
        ...params.prompt.filter((message) => message.role !== "system"),
      ],
    };
  },
};

/**
 * Claude behind a custom endpoint caches only the blocks a request marks, and
 * nothing marks the latest one the way Anthropic's own API does. So once the
 * harness has marked a prompt, its latest message gets the same mark, and each
 * step of a run reads the step before it from cache. A call the harness left
 * unmarked, like compaction, stays unmarked.
 */
export const cacheLatestMessageMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const cacheControl = params.prompt
      .map(customCacheControlOf)
      .find((mark) => mark !== undefined);
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

/** `item` with the breakpoint's options merged into its own, per provider. */
export function markedForCache<
  T extends { providerOptions?: SharedV4ProviderOptions },
>(item: T, breakpoint: SharedV4ProviderOptions): T {
  const providerOptions = { ...item.providerOptions };
  for (const [provider, options] of Object.entries(breakpoint)) {
    providerOptions[provider] = { ...providerOptions[provider], ...options };
  }

  return { ...item, providerOptions: providerOptions };
}

/**
 * Marks the item at `index` (the last by default) as a prompt cache
 * breakpoint. Unchanged when the run's model takes no breakpoint or the index
 * names no item.
 */
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

// The same endpoints have two streaming quirks the custom-provider path must
// absorb. First, `reasoning`/`reasoning_content` chunks may carry a growing
// snapshot of the whole reasoning text instead of an increment, which every
// downstream consumer (Slack Thinking card, chat SDK streams, persisted
// messages) doubles by appending. Second, usage omits
// `completion_tokens_details.reasoning_tokens`, so reasoning tokens read as 0
// even when most of the output was thinking. Rewrite snapshot deltas to their
// new suffix, and when the endpoint reports no reasoning-token split, estimate
// it from the reasoning/text character share of the reported output total.
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

// One entry per doStream call. The SDK's retry loop re-invokes doStream, so
// the recorded attempts split retry waste from server wait on the step span.
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

// A file part the provider's converter refuses fails the turn during prompt
// conversion, before any request is sent, so dropping the part and running
// again costs a local re-convert and no tokens. That is what makes a wrong
// entry in `PROVIDER_NATIVE_MEDIA` cost one attachment instead of the turn.
export const dropUnsupportedMediaMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutUnsupportedMedia);

// A text-only model behind a custom endpoint answers a picture with a 400, so a
// screenshot from an MCP tool would fail every turn after it. Retry once with
// each picture replaced by a line naming it: the turn loses its images, not the
// answer.
export const dropRefusedImagesMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutRefusedImages);

// Stored-item references are the provider's own state, so they can go stale for
// reasons no amount of care on our side prevents: the 30-day window closes, or
// the agent's model changes and the old reasoning can no longer be decrypted.
// Retry once with that state dropped. The turn then costs a full re-upload of
// its history and nothing else, instead of failing in the user's chat.
export const retryWithoutStoredItemsMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutStaleStoredItems);

/**
 * A custom endpoint gets a tool result's image inside the tool message, where
 * vLLM-style servers read it. OpenAI's own chat API answers that with a 400, so
 * the call is retried with each image in a user message after its tool message,
 * and `endpoint` sends them there from then on.
 */
export function moveRefusedToolImagesMiddleware(
  endpoint: string,
): LanguageModelMiddleware {
  // Remembered once the move is accepted, or refused the same way: a model
  // that takes no images at all then pays its drop retry, not a move as well.
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

/**
 * Strips the id an assistant part is replayed by, leaving the part to be sent
 * as content. Only ever correct alongside dropping the reasoning parts of the
 * same message: an id without its reasoning is the reference the provider
 * refuses.
 */
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

/**
 * A middleware that runs the call again when `recover` recognises the failure
 * and can say what to send instead. `recover` returning undefined rethrows, so
 * a failure it does not know about is never paid for twice. `retried` hears
 * how the retry went: undefined once accepted, else its error.
 */
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

// The same call with every non-image file part replaced by a line naming it,
// or undefined when this error is not a refused part or there was nothing to
// drop.
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

// The same call with every picture, a tool result's too, replaced by a line
// naming it, or undefined when the endpoint did not refuse the request or there
// was no picture to drop.
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

// The same call with tool result images moved into user messages, or undefined
// when the endpoint did not refuse the request or no tool result carries an
// image.
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

// Whether any user message carries a part `matches` picks out.
function carriesUserMedia(
  params: LanguageModelV4CallOptions,
  matches: (part: UserPromptPart) => part is LanguageModelV4FilePart,
): boolean {
  return params.prompt.some(
    (message) => message.role === "user" && message.content.some(matches),
  );
}

// Images are the one media kind every provider reads, so a converter that
// refused something refused something else.
function isDroppableMedia(
  part: UserPromptPart,
): part is LanguageModelV4FilePart {
  return part.type === "file" && !part.mediaType.startsWith("image/");
}

function isImage(part: UserPromptPart): part is LanguageModelV4FilePart {
  return part.type === "file" && part.mediaType.startsWith("image/");
}

// An image a user message can carry: bytes or a URL. A provider reference or
// inline text stays in the tool result it came in.
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

// A 400 a picture may have caused. A context overflow is a 400 too, and must
// reach compaction rather than pass once its images are dropped.
function isRefusedRequest(error: unknown): error is APICallError {
  return (
    APICallError.isInstance(error) &&
    error.statusCode === 400 &&
    !isContextLengthError(error.message)
  );
}

// Each tool message followed by one user message holding the images its results
// carried; the result keeps a line pointing at each one.
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

// Each tool result left with only text sent as one string: some endpoints take
// nothing else in a tool message, and every endpoint takes that.
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

// The call with every user part `drop` picks out replaced by a line naming it.
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

/**
 * OpenAI on the account's ChatGPT plan. The API key is a placeholder the fetch
 * replaces with the connection's access token on every request; the endpoint is
 * OpenAI's own, so no tenant setting reaches it.
 */
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
  // @ai-sdk/openai-compatible instead of @ai-sdk/openai: vLLM-style endpoints
  // return thinking text in `reasoning`/`reasoning_content` fields, which only
  // the compatible provider parses into reasoning parts (#115).
  const baseURL = customProviderBaseURL(providerConfig) ?? "";
  const provider = createOpenAICompatible({
    // A tool result keeps its images, as the tool returned them, unless the
    // endpoint refuses them there (`moveRefusedToolImagesMiddleware`).
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
      // Each entry wraps the ones after it: a 400 tries moving tool images first,
      // and only drops images when that is refused too. The cache mark comes
      // last, so a retry above marks its own latest message.
      middleware: [
        mergeSystemMessagesMiddleware,
        normalizeStreamDeltasMiddleware,
        dropRefusedImagesMiddleware,
        moveRefusedToolImagesMiddleware(`${baseURL} ${modelId}`),
        dropUnsupportedMediaMiddleware,
        ...(CLAUDE_MODEL_PATTERN.test(servedModelId(modelId))
          ? [cacheLatestMessageMiddleware]
          : []),
      ],
    }),
  };
}

/**
 * The `cloudflare` provider: Workers AI over REST, through AI Gateway once
 * `gatewayId` is set (`apiKey` rides `cf-aig-authorization`). Workers AI
 * models (`@cf/`, `@hf/`) keep the Workers AI provider; other ids use the
 * gateway's OpenAI-compatible endpoint, where `headers.Authorization` carries an
 * upstream key.
 */
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

// The gateway names Workers AI models `workers-ai/@cf/...`; Workers AI itself takes `@cf/...`.
function workersAIModelId(modelId: string): string {
  return modelId.replace(/^workers-ai\//, "");
}

/**
 * A 429 whose wait is only in its body gets it as `retry-after-ms`, the header
 * the AI SDK's retry already honours. Without it the SDK retries on its own
 * shorter backoff and burns the attempts before the window resets.
 */
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
    // The SDK ignores a retry header of 60s or more, so a longer wait is
    // spread over the retries at the longest delay it honours.
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

/**
 * Every model request goes out with Bun's socket idle timeout off. Bun drops a
 * connection that stays silent for 300s, and a busy provider can hold a stream
 * that long, so a model call ends on the provider's own error or the run's
 * abort signal, which `watchModelStream` in harness.ts fires on a silent
 * stream. A provider with any tenant-supplied endpoint also gets the
 * resolve-then-connect `fetch`.
 */
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

// A custom endpoint's cache defaults by the model family it serves. GPT gets
// its key in the request body, where the compatible provider copies the options
// under its name. Claude gets the cache_control its breakpoints carry, under
// `openaiCompatible`, which reaches no body. Anything else gets neither, since a
// strict endpoint refuses a field it does not know.
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

// The name a custom endpoint's compatible provider reads its options under.
function customProviderName(
  providerConfig: AgentProviderSettings | undefined,
): string {
  return typeof providerConfig?.name === "string"
    ? providerConfig.name
    : "custom";
}

// A custom endpoint's Claude breakpoint carrying `cacheControl`.
function customCacheBreakpoint(
  cacheControl: JSONValue,
): SharedV4ProviderOptions {
  return { [CUSTOM_CACHE_PROVIDER]: { [CUSTOM_CACHE_FIELD]: cacheControl } };
}

// The cache_control a custom endpoint's prompt message or one of its parts
// carries, the message's own first.
function customCacheControlOf(
  message: LanguageModelV4Message,
): JSONValue | undefined {
  const items =
    typeof message.content === "string"
      ? [message]
      : [message, ...message.content];

  return items
    .map((item) => item.providerOptions?.[CUSTOM_CACHE_PROVIDER])
    .find((options) => options?.[CUSTOM_CACHE_FIELD] !== undefined)?.[
    CUSTOM_CACHE_FIELD
  ];
}

// The model id the endpoint serves, without a router prefix like `cx/`.
function servedModelId(modelId: string | undefined): string {
  return modelId?.split("/").at(-1) ?? "";
}

// `defaults` set under `provider` unless the account configured `field` there.
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

// The message with its last block marked where the compatible provider reads
// it: a user message's last part, a tool message's last result, and the
// message itself for the rest.
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

// One conversation's prompt cache key, the same on every call it makes.
function promptCacheKey(conversationKey: string): string {
  return createHash("sha256")
    .update(conversationKey)
    .digest("hex")
    .slice(0, 32);
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

// Everything the request says about items the provider is holding: the ids an
// assistant part is replayed by, the reasoning parts they must be paired with,
// and any response chain the account pinned through `providerOptions`. They go
// together. A surviving `previousResponseId` makes the provider skip the very
// history this retry exists to send in full.
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
