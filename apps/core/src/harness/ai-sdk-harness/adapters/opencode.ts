/**
 * OpenCode adapter construction and Broods provider mapping.
 */

import {
  VERSION,
  createOpenCode,
  type OpenCodeHarnessSettings,
} from "@ai-sdk/harness-opencode";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveHarnessProviderBaseUrl,
} from "../provider.ts";

export const OPENCODE_HARNESS_VERSION = VERSION;

export function createConfiguredOpenCodeAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const model = requireHarnessModelId(agentConfig);
  const providerName = requireHarnessProviderName(agentConfig);
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  const baseUrl = resolveHarnessProviderBaseUrl(provider);
  const auth =
    providerName === "custom"
      ? {
          openaiCompatible: {
            apiKey: provider.apiKey!,
            baseUrl: baseUrl,
            name: provider.name ?? "custom",
          },
        }
      : providerName === "openai"
        ? {
            openai: {
              apiKey: provider.apiKey!,
              ...(baseUrl ? { baseUrl: baseUrl } : {}),
              organization: provider.organization,
              project: provider.project,
            },
          }
        : providerName === "anthropic"
          ? {
              anthropic: {
                apiKey: provider.apiKey!,
                ...(baseUrl ? { baseUrl: baseUrl } : {}),
              },
            }
          : providerName === "gateway"
            ? {
                gateway: {
                  apiKey: provider.apiKey!,
                  ...(baseUrl ? { baseUrl: baseUrl } : {}),
                },
              }
            : undefined;
  if (!auth) {
    throw new Error(
      "config.harness.type opencode requires the anthropic, custom, gateway, or openai model provider",
    );
  }
  const reasoning = agentConfig.model?.reasoning;

  return createOpenCode({
    auth: auth,
    model: model,
    provider:
      providerName === "custom" ? (provider.name ?? "custom") : providerName,
    reasoningVariant: reasoning && reasoning !== "none" ? reasoning : undefined,
    startupTimeoutMs: harness.startupTimeoutMs,
  });
}

export function createOpenCodeAdapter(
  settings?: OpenCodeHarnessSettings,
): HarnessAgentAdapter {
  return createOpenCode(settings);
}
