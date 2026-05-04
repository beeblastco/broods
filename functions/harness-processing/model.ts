/**
 * Account-configured model resolution for harness-processing.
 * Keep provider construction and AI SDK setting projection here.
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type {
  AccountConfig,
  AccountModelProviderName,
  AccountProviderSettings,
} from "../_shared/accounts.ts";

export interface ResolvedModelProvider {
  providerName: AccountModelProviderName;
  provider: unknown;
  model: LanguageModel;
}

export function resolveConfiguredModel(accountConfig: AccountConfig): ResolvedModelProvider {
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

export function modelSettingsFromModelConfig(accountConfig: AccountConfig): Record<string, unknown> {
  const {
    provider: _provider,
    modelId: _modelId,
    options: _options,
    ...settings
  } = accountConfig.model ?? {};

  return settings;
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
