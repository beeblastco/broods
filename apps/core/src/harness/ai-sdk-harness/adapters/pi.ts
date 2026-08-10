/**
 * Pi adapter construction and Broods provider mapping.
 */

import { VERSION, createPi, type PiHarnessSettings } from "@ai-sdk/harness-pi";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveHarnessProviderBaseUrl,
} from "../provider.ts";

export const PI_HARNESS_VERSION = VERSION;

export function createConfiguredPiAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const model = requireHarnessModelId(agentConfig);
  const providerName = requireHarnessProviderName(agentConfig);
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  const baseUrl = resolveHarnessProviderBaseUrl(provider);
  const prefix =
    providerName === "vercel"
      ? "AI_GATEWAY"
      : providerName === "custom"
        ? (provider.name ?? "custom")
            .replace(/[^A-Za-z0-9]+/g, "_")
            .toUpperCase()
        : providerName.toUpperCase();
  const auth =
    providerName === "vercel"
      ? {
          gateway: {
            apiKey: provider.apiKey!,
            ...(baseUrl ? { baseUrl: baseUrl } : {}),
          },
        }
      : {
          customEnv: {
            [`${prefix}_API_KEY`]: provider.apiKey!,
            ...(baseUrl ? { [`${prefix}_BASE_URL`]: baseUrl } : {}),
          },
        };
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
    auth: auth,
    model: model,
    thinkingLevel: thinkingLevel,
  });
}

export function createPiAdapter(
  settings?: PiHarnessSettings,
): HarnessAgentAdapter {
  return createPi(settings);
}
