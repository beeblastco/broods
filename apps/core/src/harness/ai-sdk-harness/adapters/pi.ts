/**
 * Pi adapter construction and Broods provider mapping.
 */

import { VERSION, createPi, type PiHarnessSettings } from "@ai-sdk/harness-pi";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { HarnessV1AuthenticationEnvironment } from "@ai-sdk/harness";
import type {
  AgentConfig,
  AgentProviderSettings,
} from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveGatewayAuthEnv,
  resolveHarnessProviderBaseUrl,
} from "../provider.ts";

export const PI_HARNESS_VERSION = VERSION;

export function createConfiguredPiAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const model = requireHarnessModelId(agentConfig);
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
    model: model,
    thinkingLevel: thinkingLevel,
  });
}

export function createPiAdapter(
  settings?: PiHarnessSettings,
): HarnessAgentAdapter {
  return createPi(settings);
}

/**
 * Pi registers a provider per `<PREFIX>_API_KEY` / `<PREFIX>_BASE_URL` pair it
 * finds, so a custom endpoint reaches it as its own label rather than as an
 * OpenAI-compatible override.
 */
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
