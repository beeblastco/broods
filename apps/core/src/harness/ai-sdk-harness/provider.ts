/**
 * Shared model-provider resolution for AI SDK Harness adapters.
 */

import type {
  AgentConfig,
  AgentProviderSettings,
} from "../../shared/domain/agent-config.ts";

type HarnessProviderName = NonNullable<
  NonNullable<AgentConfig["model"]>["provider"]
>;

export function requireHarnessModelId(agentConfig: AgentConfig): string {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required for config.harness");
  }

  return modelId;
}

export function requireHarnessProviderName(
  agentConfig: AgentConfig,
): HarnessProviderName {
  const providerName = agentConfig.model?.provider;
  if (!providerName) {
    throw new Error("config.model.provider is required for config.harness");
  }

  return providerName;
}

export function requireHarnessProviderSettings(
  agentConfig: AgentConfig,
  providerName: HarnessProviderName,
): AgentProviderSettings {
  const settings = agentConfig.provider?.[providerName];
  if (!settings) {
    throw new Error(
      `config.provider.${providerName} is required for config.harness`,
    );
  }
  if (!settings.apiKey) {
    throw new Error(
      `config.provider.${providerName}.apiKey is required for config.harness`,
    );
  }

  return settings;
}

export function resolveAnthropicOrVercelAuth(
  providerName: "anthropic" | "vercel",
  provider: AgentProviderSettings,
):
  | { anthropic: { apiKey: string; baseUrl?: string } }
  | { gateway: { apiKey: string; baseUrl?: string } } {
  const baseUrl = resolveHarnessProviderBaseUrl(provider);
  const settings = {
    apiKey: provider.apiKey!,
    ...(baseUrl ? { baseUrl: baseUrl } : {}),
  };

  return providerName === "anthropic"
    ? { anthropic: settings }
    : { gateway: settings };
}

export function resolveHarnessProviderBaseUrl(
  provider: AgentProviderSettings,
): string | undefined {
  return provider.base_url ?? provider.baseURL;
}

// Provider settings are an open bag passed through to the AI SDK factory, so
// the few keys the harness adapters themselves forward are read as strings here
// rather than pinned in `AgentProviderSettings`.
export function harnessProviderSetting(
  provider: AgentProviderSettings,
  key: string,
): string | undefined {
  const value = provider[key];

  return typeof value === "string" ? value : undefined;
}
