/**
 * Agent-configured provider resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

import { createHash } from "node:crypto";
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
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity } from "@ai-sdk/perplexity";
import {
  APICallError,
  UnsupportedFunctionalityError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FilePart,
  type LanguageModelV4Message,
  type LanguageModelV4StreamPart,
  type SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createVercel } from "@ai-sdk/vercel";
import { createXai } from "@ai-sdk/xai";
import {
  jsonSchema,
  Output,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type TranscriptionModel,
} from "ai";
import { createMinimax } from "vercel-minimax-ai-provider";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import type {
  AgentConfig,
  AgentModelOutputConfig,
  AgentModelProviderOptions,
  AgentProviderSettings,
} from "../shared/domain/agent-config.ts";
import { logInfo } from "../shared/log.ts";
import { unreadableMediaNote } from "../shared/media-types.ts";

// Providers that answer on OpenAI's Responses API, where a replayed assistant
// message is a reference to the item the provider still holds rather than the
// content itself. That reference is only valid while the item resolves and
// still carries the reasoning item it was produced with, which is why these
// providers keep reasoning in context and get the retry below.
export const STORED_ITEM_PROVIDERS: ReadonlySet<AccountModelProviderName> =
  new Set(["azure", "openai"]);

/**
 * How inbound audio is read, per provider: the factory that ships speech-to-text
 * and the models to ask it for, best first. Providers absent here have none.
 *
 * More than one id because a provider's models disagree about containers, and
 * the disagreement decides whether the feature works at all: `whisper-1` takes
 * the ogg/opus every voice-note channel sends, and `gpt-4o-mini-transcribe`,
 * which is cheaper and better, does not. Trying the cheap one first and falling
 * back on a refused file is what makes a Telegram voice note transcribe on
 * OpenAI at all.
 *
 * Keyed to the factory rather than looked up on an already-built provider so
 * the compiler checks the method still exists. Both `transcription` and
 * `transcriptionModel` are there at runtime, but openai and groq declare only
 * the first, and a rename would otherwise degrade in silence: no model, a note
 * saying the provider has none, and nothing failing anywhere.
 */
const PROVIDER_TRANSCRIPTION: Partial<
  Record<AccountModelProviderName, TranscriptionSource>
> = {
  groq: { factory: createGroq, modelIds: ["whisper-large-v3-turbo"] },
  mistral: { factory: createMistral, modelIds: ["voxtral-mini-latest"] },
  openai: {
    factory: createOpenAI,
    modelIds: ["gpt-4o-mini-transcribe", "whisper-1"],
  },
};

// How OpenAI names a reference it cannot honour: the item aged out of its 30-day
// window, it lost the reasoning item it was paired with, or its reasoning was
// encrypted for a different model.
const STALE_STORED_ITEM_PATTERN =
  /without its required (?:'reasoning' item|following item)|Item with id .{0,80}not found|encrypted[_ ]content/i;

// What every AI SDK provider factory has in common: settings in, callable
// provider out. The settings each one accepts are read off it, never restated.
type ModelProviderFactory = (settings: never) => ModelProviderInstance;

interface ModelProviderInstance {
  // Never the string form of `LanguageModel`: a constructed provider hands back
  // a model instance, which is what middleware can wrap.
  (modelId: string): Exclude<LanguageModel, string>;
}

// A provider that reads audio, and which of its models do it.
interface TranscriptionSource {
  factory: (settings: never) => {
    transcription: (modelId: string) => Exclude<TranscriptionModel, string>;
  };
  modelIds: readonly string[];
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
  AccountModelProviderName,
  ModelProviderFactory
> {
  return {
    anthropic: createAnthropic,
    azure: createAzure,
    baseten: createBaseten,
    bedrock: createAmazonBedrock,
    cerebras: createCerebras,
    cohere: createCohere,
    custom: createOpenAICompatible,
    deepinfra: createDeepInfra,
    deepseek: createDeepSeek,
    fireworks: createFireworks,
    google: createGoogle,
    groq: createGroq,
    minimax: createMinimax,
    mistral: createMistral,
    openai: createOpenAI,
    perplexity: createPerplexity,
    togetherai: createTogetherAI,
    v0: createVercel,
    vercel: createGateway,
    vertex: createGoogleVertex,
    xai: createXai,
  };
}

export function resolveConfiguredModel(
  agentConfig: AgentConfig,
): ResolvedModelProvider {
  const providerName = requireModelProvider(agentConfig);
  const modelId = requireModelId(agentConfig);
  const providerConfig = requireProviderSettings(agentConfig, providerName);
  if (providerName === "custom") {
    return resolveOpenAICompatibleModel(providerName, providerConfig, modelId);
  }

  // The registry's value type is a union of factories, so its parameter narrows
  // to an intersection no single provider's settings satisfy. Settings are
  // validated by `normalizeProviderSettings` and passed through verbatim, so the
  // cast is the one seam where account config meets the SDK's own typing.
  const createProvider = modelProviderFactories()[providerName] as (
    settings: AgentProviderSettings,
  ) => ModelProviderInstance;
  const provider = createProvider(providerConfig);
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
 * The speech-to-text models to read inbound audio with, best first, or empty
 * when this account's provider ships none or its config cannot build them.
 * Empty rather than a throw: a half-configured account should lose its
 * transcript and keep the message it arrived on.
 */
export function resolveTranscriptionModels(
  agentConfig: AgentConfig,
): Exclude<TranscriptionModel, string>[] {
  const providerName = agentConfig.model?.provider;
  const source = providerName
    ? PROVIDER_TRANSCRIPTION[providerName]
    : undefined;
  if (!providerName || !source) {
    return [];
  }
  try {
    const provider = source.factory(
      requireProviderSettings(agentConfig, providerName) as never,
    );

    return source.modelIds.map((modelId) => provider.transcription(modelId));
  } catch {
    return [];
  }
}

export function modelSettingsFromModelConfig(
  agentConfig: AgentConfig,
): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    providerOptions: _providerOptions,
    output: _output,
    ...settings
  } = agentConfig.model ?? {};

  return settings;
}

/**
 * Prompt-cache defaults for a conversation run: Anthropic gets an ephemeral
 * cacheControl (caching there is opt-in per request), OpenAI a promptCacheKey
 * hashed from the conversation key (prefix routing, required from GPT-5.6 on).
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
    if (configured?.anthropic?.cacheControl !== undefined) {
      return configured;
    }

    return {
      ...configured,
      anthropic: {
        ...configured?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    };
  }
  if (!STORED_ITEM_PROVIDERS.has(providerName)) {
    return configured;
  }

  const openaiOptions = configured?.openai;
  if (openaiOptions?.promptCacheKey !== undefined) {
    return configured;
  }

  return {
    ...configured,
    openai: {
      ...openaiOptions,
      promptCacheKey: createHash("sha256")
        .update(conversationKey)
        .digest("hex")
        .slice(0, 32),
    },
  };
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

    return {
      ...params,
      prompt: [
        {
          role: "system",
          content: systems.map((message) => message.content).join("\n\n"),
        },
        ...params.prompt.filter((message) => message.role !== "system"),
      ],
    };
  },
};

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

// One entry per doStream call — the SDK's retry loop re-invokes doStream, so
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

// Stored-item references are the provider's own state, so they can go stale for
// reasons no amount of care on our side prevents: the 30-day window closes, or
// the agent's model changes and the old reasoning can no longer be decrypted.
// Retry once with that state dropped — the turn then costs a full re-upload of
// its history and nothing else, instead of failing in the user's chat.
export const retryWithoutStoredItemsMiddleware: LanguageModelMiddleware =
  retryingMiddleware(withoutStaleStoredItems);

/**
 * A middleware that runs the call again when `recover` recognises the failure
 * and can say what to send instead. `recover` returning undefined rethrows, so
 * a failure it does not know about is never paid for twice.
 */
function retryingMiddleware(
  recover: (
    error: unknown,
    params: LanguageModelV4CallOptions,
  ) => LanguageModelV4CallOptions | undefined,
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

        return await model.doGenerate(retry);
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

        return await model.doStream(retry);
      }
    },
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

// The same call with every non-image file part replaced by a line naming it,
// or undefined when this error is not a refused part or there was nothing to
// drop. Images are kept: they are the one media kind every provider reads, so a
// converter that refused something refused something else.
function withoutUnsupportedMedia(
  error: unknown,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions | undefined {
  if (
    !UnsupportedFunctionalityError.isInstance(error) ||
    !params.prompt.some(
      (message) =>
        message.role === "user" && message.content.some(isDroppableMedia),
    )
  ) {
    return undefined;
  }
  logInfo("Retrying model call without media the provider refused", {
    error: error.message,
  });

  return {
    ...params,
    prompt: params.prompt.map((message) =>
      message.role !== "user"
        ? message
        : {
            ...message,
            content: message.content.map((part) =>
              isDroppableMedia(part)
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

// Images are the one media kind every provider reads, so a converter that
// refused something refused something else.
function isDroppableMedia(
  part: Extract<LanguageModelV4Message, { role: "user" }>["content"][number],
): part is LanguageModelV4FilePart {
  return part.type === "file" && !part.mediaType.startsWith("image/");
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

function resolveOpenAICompatibleModel(
  providerName: "custom",
  providerConfig: AgentProviderSettings,
  modelId: string,
): ResolvedModelProvider {
  const { base_url: _baseUrl, ...openAIConfig } = providerConfig;
  // @ai-sdk/openai-compatible instead of @ai-sdk/openai: vLLM-style endpoints
  // return thinking text in `reasoning`/`reasoning_content` fields, which only
  // the compatible provider parses into reasoning parts (#115).
  const provider = createOpenAICompatible({
    ...openAIConfig,
    baseURL: customProviderBaseURL(providerConfig) ?? "",
    name:
      typeof providerConfig.name === "string"
        ? providerConfig.name
        : providerName,
    includeUsage: true,
  });

  return {
    providerName: providerName,
    provider: provider,
    model: wrapLanguageModel({
      model: provider(modelId),
      middleware: [
        mergeSystemMessagesMiddleware,
        normalizeStreamDeltasMiddleware,
      ],
    }),
  };
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
        ? ` (found "baseUrl" — use "base_url" or "baseURL")`
        : "";
    throw new Error(`config.provider.custom.base_url is required${hint}`);
  }

  return providerConfig;
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

// Parse the structure output to vercel-ai sdk type
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
// together — a surviving `previousResponseId` makes the provider skip the very
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
