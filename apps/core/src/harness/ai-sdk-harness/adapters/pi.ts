import { VERSION, createPi, type PiHarnessSettings } from "@ai-sdk/harness-pi";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { HarnessV1AuthenticationEnvironment } from "@ai-sdk/harness";
import type {
  AgentConfig,
  AgentProviderSettings,
} from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveGatewayAuthEnv,
  resolveHarnessProviderBaseUrl,
} from "../provider.ts";

export const PI_HARNESS_VERSION = VERSION;

export function createConfiguredPiAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const providerName = requireHarnessProviderName(agentConfig);
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  const reasoning = agentConfig.model?.reasoning;
  const thinkingLevel =
    reasoning === "none"
      ? "off"
      : reasoning === "minimal" ||
          reasoning === "low" ||
          reasoning === "medium" ||
          reasoning === "high" ||
          reasoning === "xhigh"
        ? reasoning
        : undefined;

  return createPi({
    auth:
      providerName === "vercel"
        ? resolveGatewayAuthEnv(provider)
        : resolvePrefixedAuthEnv(providerName, provider),
    thinkingLevel: thinkingLevel,
  });
}

export function createPiAdapter(
  settings?: PiHarnessSettings,
): HarnessAgentAdapter {
  return createPi(settings);
}

// Pi registers a provider per <PREFIX>_API_KEY/_BASE_URL pair: a custom endpoint keeps its label.
function resolvePrefixedAuthEnv(
  providerName: string,
  provider: AgentProviderSettings,
): HarnessV1AuthenticationEnvironment {
  const baseUrl = resolveHarnessProviderBaseUrl(provider);
  const prefix =
    providerName === "custom"
      ? (provider.name ?? "custom").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()
      : providerName.toUpperCase();

  return {
    [`${prefix}_API_KEY`]: provider.apiKey!,
    ...(baseUrl ? { [`${prefix}_BASE_URL`]: baseUrl } : {}),
  };
}
