/**
 * Codex adapter construction and Broods provider mapping.
 */

import {
  VERSION,
  createCodex,
  type CodexHarnessSettings,
} from "@ai-sdk/harness-codex";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  harnessProviderSetting,
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveHarnessProviderBaseUrl,
} from "../provider.ts";

export const CODEX_HARNESS_VERSION = VERSION;

export function createCodexAdapter(
  settings?: CodexHarnessSettings,
): HarnessAgentAdapter {
  return createCodex(settings);
}

export function createConfiguredCodexAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const model = requireHarnessModelId(agentConfig);
  const providerName = requireHarnessProviderName(agentConfig);
  if (
    providerName !== "custom" &&
    providerName !== "openai" &&
    providerName !== "vercel"
  ) {
    throw new Error(
      "config.harness.type codex requires the custom, openai, or vercel model provider",
    );
  }
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  const baseUrl = resolveHarnessProviderBaseUrl(provider);
  const auth =
    providerName === "custom"
      ? {
          openaiCompatible: {
            apiKey: provider.apiKey!,
            baseUrl: baseUrl,
            modelProviderName:
              harnessProviderSetting(provider, "name") ?? "custom",
          },
        }
      : providerName === "openai"
        ? {
            openai: {
              apiKey: provider.apiKey!,
              ...(baseUrl ? { baseUrl: baseUrl } : {}),
              organization: harnessProviderSetting(provider, "organization"),
              project: harnessProviderSetting(provider, "project"),
            },
          }
        : {
            gateway: {
              apiKey: provider.apiKey!,
              ...(baseUrl ? { baseUrl: baseUrl } : {}),
            },
          };
  const reasoning = agentConfig.model?.reasoning;
  const reasoningEffort =
    reasoning === "low" || reasoning === "medium" || reasoning === "high"
      ? reasoning
      : undefined;

  return createCodex({
    auth: auth,
    model: model,
    reasoningEffort: reasoningEffort,
    startupTimeoutMs: harness.startupTimeoutMs,
    webSearch: harness.webSearch,
  });
}
