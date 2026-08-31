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
  requireHarnessModelId,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveGatewayAuthEnv,
  resolveOpenAiAuthEnv,
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
  // `custom` and `openai` are the same wire contract to codex: an API key and
  // an optional base URL. The endpoint label a custom provider carries has no
  // env equivalent, so codex names the route "Agent Bridge OpenAI" itself.
  const auth =
    providerName === "vercel"
      ? resolveGatewayAuthEnv(provider)
      : resolveOpenAiAuthEnv(provider);
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
