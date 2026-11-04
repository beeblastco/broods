import {
  VERSION,
  createOpenCode,
  type OpenCodeHarnessSettings,
} from "@ai-sdk/harness-opencode";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { AgentConfig } from "../../../shared/domain/agent-config.ts";
import {
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

// OpenCode 1.18.34 provider/transform.ts, excluding `max`, which is above `xhigh`.
function openCodeVariants(
  provider: NonNullable<AgentConfig["model"]>["provider"],
  modelId: string,
): readonly OpenCodeLevel[] {
  const id = modelId.toLowerCase();
  if (
    /deepseek-(?:chat|reasoner|r1|v3)|minimax|kimi|k2p|qwen|big-pickle/.test(
      id,
    ) ||
    (id.includes("glm") && !/glm-5[.p-]2/.test(id))
  ) {
    return [];
  }
  if (id.includes("grok-3-mini")) return ["low", "high"];
  const gateway = provider === "vercel";
  if (provider === "anthropic" || (gateway && id.includes("anthropic"))) {
    return openCodeAnthropicVariants(id, gateway);
  }
  if (gateway && id.includes("google")) {
    return /gemini-2[.-]5(?:[.-]|$)/.test(id) ? ["high"] : ["low", "high"];
  }
  return openCodeOpenAiVariants(id, gateway);
}

function openCodeAnthropicVariants(
  id: string,
  gateway: boolean,
): readonly OpenCodeLevel[] {
  const version = /claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i.exec(
    id,
  );
  const major = Number(version?.[1]);
  const minor = Number(version?.[2] ?? 0);
  if (
    id.includes("claude-") &&
    (!version || major > 4 || (major === 4 && minor >= 7))
  ) {
    return ["low", "medium", "high", "xhigh"];
  }
  if (
    /(?:opus|sonnet)-4[.-]6|4[.-]6-(?:opus|sonnet)/.test(id) ||
    (!gateway && /opus-4[.-]5/.test(id))
  ) {
    return ["low", "medium", "high"];
  }

  return ["high"];
}

function openCodeOpenAiVariants(
  id: string,
  gateway: boolean,
): readonly OpenCodeLevel[] {
  if (!gateway && id.includes("deep-research")) return ["medium"];
  const gpt5 = /(?:^|\/)gpt-5(?:[.-]|$)/.test(id);
  // OpenCode also reads a dated `gpt-5-2025-08-07` as version 2025.
  const version = Number(/(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/.exec(id)?.[1] ?? 0);
  if (gpt5 && id.includes("-chat")) return version ? ["medium"] : [];
  if (/(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/.test(id)) return ["high"];
  const codex = gpt5 && id.includes("codex");
  if (!codex && /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/.test(id)) {
    return ["medium", "high", "xhigh"];
  }
  if (gateway && !codex && !version) return OPENCODE_LEVELS;
  const gated: Partial<Record<OpenCodeLevel, boolean>> = {
    none: codex ? version >= 3 : version >= 1,
    minimal: version === 0 && !codex && gpt5,
    xhigh: version >= 2 || (codex && id.includes("codex-max")),
  };

  return OPENCODE_LEVELS.filter((level): boolean => gated[level] ?? true);
}
