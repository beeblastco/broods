import {
  VERSION,
  createOpenCode,
  type OpenCodeHarnessSettings,
} from "@ai-sdk/harness-opencode";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
  CLAUDE_WITHOUT_EFFORT,
  requireHarnessProviderName,
  requireHarnessProviderSettings,
  resolveAnthropicAuthEnv,
  resolveGatewayAuthEnv,
  resolveOpenAiAuthEnv,
  warnReasoningChanged,
} from "../provider.ts";

const OPENCODE_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

type OpenCodeLevel = (typeof OPENCODE_LEVELS)[number];

export const OPENCODE_HARNESS_VERSION = VERSION;

export function createConfiguredOpenCodeAdapter(
  agentConfig: AgentConfig,
): HarnessAgentAdapter {
  const harness = agentConfig.harness!;
  const providerName = requireHarnessProviderName(agentConfig);
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  // No `custom`: OpenCode maps an unknown provider label to Anthropic, dropping an OpenAI key.
  const auth =
    providerName === "anthropic"
      ? resolveAnthropicAuthEnv(provider)
      : providerName === "openai"
        ? resolveOpenAiAuthEnv(provider)
        : providerName === "vercel"
          ? resolveGatewayAuthEnv(provider)
          : undefined;
  if (!auth) {
    throw new Error(
      "config.harness.type opencode requires the anthropic, openai, or vercel model provider",
    );
  }
  const reasoningVariant = openCodeVariant(agentConfig.model);
  warnReasoningChanged(agentConfig, reasoningVariant);

  return createOpenCode({
    auth: auth,
    provider: providerName,
    reasoningVariant: reasoningVariant,
    startupTimeoutMs: harness.startupTimeoutMs,
  });
}

export function createOpenCodeAdapter(
  settings?: OpenCodeHarnessSettings,
): HarnessAgentAdapter {
  return createOpenCode(settings);
}

// OpenCode stores any variant name and applies only the model's own, so send the nearest one.
// Ties go to the higher variant, and `none` is only ever sent for `none`.
function openCodeVariant(
  model: AgentConfig["model"],
): OpenCodeLevel | undefined {
  const reasoning = model?.reasoning;
  if (!reasoning || reasoning === "provider-default") return undefined;
  const variants = openCodeVariants(model.provider, model.modelId ?? "");
  if (reasoning === "none") {
    return variants.includes("none") ? "none" : undefined;
  }
  // The config refuses `max`; only the AI SDK type carries it.
  const rank = OPENCODE_LEVELS.indexOf(
    reasoning === "max" ? "xhigh" : reasoning,
  );
  const distance = (level: OpenCodeLevel): number =>
    Math.abs(OPENCODE_LEVELS.indexOf(level) - rank);

  return variants.reduce<OpenCodeLevel | undefined>(
    (best, variant): OpenCodeLevel | undefined =>
      variant !== "none" && (!best || distance(variant) <= distance(best))
        ? variant
        : best,
    undefined,
  );
}

// OpenCode 1.18 variant names per model (provider/transform.ts), less `max`: it is above `xhigh`.
function openCodeVariants(
  provider: string | undefined,
  modelId: string,
): readonly OpenCodeLevel[] {
  const id = modelId.toLowerCase();
  if (provider === "anthropic" || id.startsWith("anthropic/")) {
    if (CLAUDE_WITHOUT_EFFORT.test(id)) return ["high"];
    return /opus-4[.-]5|(?:opus|sonnet)-4[.-]6/.test(id)
      ? ["low", "medium", "high"]
      : ["low", "medium", "high", "xhigh"];
  }
  if (id.startsWith("google/")) {
    return id.includes("gemini-2.5") ? ["high"] : ["low", "high"];
  }
  if (provider === "vercel" && !id.startsWith("openai/")) {
    return OPENCODE_LEVELS;
  }
  // Matches OpenCode's own parse, which also reads a dated `gpt-5-2025-08-07` as version 2025.
  const version = Number(/gpt-5[.-](\d+)(?:[.-]|$)/.exec(id)?.[1] ?? 0);
  if (/gpt-5[.-].*chat/.test(id)) return version ? ["medium"] : [];
  if (/gpt-5[.-]?pro(?:[.-]|$)/.test(id)) return ["high"];
  if (/gpt-5[.-]\d+[.-]pro(?:[.-]|$)/.test(id)) {
    return ["medium", "high", "xhigh"];
  }
  const codex = id.includes("codex");
  const gated: Partial<Record<OpenCodeLevel, boolean>> = {
    none: codex ? version >= 3 : version >= 1,
    minimal: version === 0 && !codex && id.includes("gpt-5"),
    xhigh: version >= 2 || id.includes("codex-max"),
  };

  return OPENCODE_LEVELS.filter((level): boolean => gated[level] ?? true);
}
