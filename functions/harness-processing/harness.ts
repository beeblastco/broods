/**
 * Agent-side harness core.
 * Keep turn context assembly, model invocation, and tools orchestration here. 
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGateway } from "@ai-sdk/gateway";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type {
  AccountConfig,
  AccountModelProviderName,
  AccountProviderSettings,
} from "../_shared/accounts.ts";
import { logError, logInfo } from "../_shared/log.ts";
import type { Session, TurnContextSnapshot } from "./session.ts";
import { createTools } from "./tools/index.ts";

interface ResolvedModelProvider {
  providerName: AccountModelProviderName;
  provider: unknown;
  model: LanguageModel;
}

// Default max agent iterations to prevent looping or too long execution.
const MAX_AGENT_ITERATIONS = 30;

export interface AgentReplyHooks {
  onFinalText(text: string): Promise<void>;
  onErrorText(error: string): Promise<void>;
}

export async function runAgentLoop(
  session: Session,
  turnContext: TurnContextSnapshot,
  accountConfig: AccountConfig,
  reply?: AgentReplyHooks,
) {
  let didFail = false;
  let failureText: string | null = null;
  let promptContext = turnContext.promptContext;
  const configuredModel = resolveConfiguredModel(accountConfig);

  const tools = {
    ...createTools({
      conversationKey: session.conversationKey,
      filesystemNamespace: session.filesystemNamespace(),
      modelProviderName: configuredModel.providerName,
      modelProvider: configuredModel.provider,
    }, accountConfig),
  } satisfies ToolSet;
  const enabledTools = Object.keys(tools).length > 0 ? tools : undefined;
  const modelSettings = streamTextSettingsFromModelConfig(accountConfig);

  const stream = streamText({
    maxOutputTokens: 16000,
    ...modelSettings,
    model: configuredModel.model,
    system: turnContext.system,
    messages: turnContext.messages,
    ...(enabledTools ? { tools: enabledTools } : {}),
    ...(accountConfig.model?.options ? { providerOptions: accountConfig.model.options as never } : {}),
    stopWhen: stepCountIs(accountConfig.maxAgentIterations ?? MAX_AGENT_ITERATIONS),
    prepareStep: async () => {
      const refreshed = await session.loadRefreshedSystemPromptParts({
        promptContext: promptContext,
        ephemeralSystem: turnContext.ephemeralSystem,
      });
      promptContext = refreshed.promptContext;

      return {
        system: refreshed.system,
      };
    },
    onError: async ({ error }) => {
      const errorText = error instanceof Error ? error.message : String(error);
      didFail = true;
      failureText = errorText;
      logError("Agent loop failed", {
        conversationKey: session.conversationKey,
        error: errorText,
      });

      await reply?.onErrorText(errorText).catch(() => { });
    },
    onFinish: async ({ response, text }) => {
      const finalText = text.trim();

      try {
        await session.persistModelMessages(response.messages);

        if (!finalText) {
          const errorText = "Model returned empty response";
          didFail = true;
          failureText = errorText;
          logError(errorText, {
            conversationKey: session.conversationKey,
            eventId: session.eventId,
          });
          await reply?.onErrorText(errorText).catch(() => { });
          return;
        }

        await reply?.onFinalText(finalText);
        logInfo("Processing complete", { conversationKey: session.conversationKey });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        didFail = true;
        failureText = errorText;
        logError("Post-generation steps failed", {
          conversationKey: session.conversationKey,
          error: errorText,
        });

        await reply?.onErrorText(errorText).catch(() => { });
      }
    },
  });

  return Object.assign(stream, {
    didFail: () => didFail,
    failureText: () => failureText,
  });
}

function resolveConfiguredModel(accountConfig: AccountConfig): ResolvedModelProvider {
  const providerName = requireModelProvider(accountConfig);
  const modelId = requireModelId(accountConfig);
  const providerConfig = requireProviderSettings(accountConfig, providerName);

  switch (providerName) {
    case "google":
      return resolveProviderModel(providerName, createGoogleGenerativeAI(providerConfig as never), modelId);
    case "openai":
      return resolveProviderModel(providerName, createOpenAI(providerConfig as never), modelId);
    case "bedrock":
      return resolveProviderModel(providerName, createAmazonBedrock(providerConfig as never), modelId);
    case "gateway":
      return resolveProviderModel(providerName, createGateway(providerConfig as never), modelId);
  }
}

function resolveProviderModel(
  providerName: AccountModelProviderName,
  provider: (modelId: string) => LanguageModel,
  modelId: string,
): ResolvedModelProvider {
  return {
    providerName,
    provider,
    model: provider(modelId),
  };
}

function requireModelProvider(accountConfig: AccountConfig): AccountModelProviderName {
  const provider = accountConfig.model?.provider;
  if (!provider) {
    throw new Error("config.model.provider is required");
  }
  return provider;
}

function requireModelId(accountConfig: AccountConfig): string {
  const modelId = accountConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required");
  }
  return modelId;
}

function requireProviderSettings(
  accountConfig: AccountConfig,
  providerName: AccountModelProviderName,
): AccountProviderSettings {
  const providerConfig = accountConfig.provider?.[providerName];
  if (!providerConfig) {
    throw new Error(`config.provider.${providerName} is required`);
  }
  if (!providerConfig.apiKey) {
    throw new Error(`config.provider.${providerName}.apiKey is required`);
  }
  return providerConfig;
}

function streamTextSettingsFromModelConfig(accountConfig: AccountConfig): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    options: _options,
    ...settings
  } = accountConfig.model ?? {};

  return settings;
}
