import {
  VERSION,
  createCodex,
  type CodexHarnessSettings,
} from "@ai-sdk/harness-codex";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  harnessEffort,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveGatewayAuthEnv,
  resolveOpenAiAuthEnv,
  warnReasoningChanged,
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
  // To codex, `custom` is `openai` (key + optional base URL); the custom label has no env to ride.
  const auth =
    providerName === "vercel"
      ? resolveGatewayAuthEnv(provider)
      : resolveOpenAiAuthEnv(provider);
  const reasoningEffort = harnessEffort(agentConfig.model?.reasoning);
  warnReasoningChanged(agentConfig, reasoningEffort);

  return createCodex({
    auth: auth,
    reasoningEffort: reasoningEffort,
    startupTimeoutMs: harness.startupTimeoutMs,
    webSearch: harness.webSearch,
  });
}
