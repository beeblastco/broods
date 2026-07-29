/**
 * AI SDK HarnessAgent construction over Broods-owned persistent sandboxes.
 */

import {
    VERSION as CLAUDE_CODE_HARNESS_VERSION,
    createClaudeCode,
    type ClaudeCodeHarnessSettings,
} from "@ai-sdk/harness-claude-code";
import {
    VERSION as CODEX_HARNESS_VERSION,
    createCodex,
    type CodexHarnessSettings,
} from "@ai-sdk/harness-codex";
import {
    VERSION as PI_HARNESS_VERSION,
    createPi,
    type PiHarnessSettings,
} from "@ai-sdk/harness-pi";
import {
    HarnessAgent,
    type HarnessAgentPermissionMode,
    type HarnessAgentSandboxConfig,
    type HarnessAgentSkill,
    type HarnessAgentToolApprovalConfiguration,
} from "@ai-sdk/harness/agent";
import { createBroodsSandbox } from "@broods/ai-sdk-sandbox";
import type { ToolSet } from "ai";
import type {
  AgentConfig,
  AgentProviderSettings,
} from "../shared/domain/agent-config.ts";
import { createMicrovmHarnessDriver } from "./sandbox/microvm-harness-driver.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";
import { createWorkdirHarnessDriver } from "./sandbox/workdir-harness-driver.ts";

const DEFAULT_HARNESS_BRIDGE_PORT = 4_321;
const ENSURE_PNPM_COMMAND =
  "command -v pnpm >/dev/null 2>&1 || npm install --global pnpm@10.34.5 --no-audit --no-fund";
const ENSURE_HARNESS_WORKSPACE_COMMAND = "mkdir -p /workspace";
const CLAUDE_CODE_BUILTIN_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "webSearch",
  "write",
]);
const CODEX_BUILTIN_TOOL_NAMES = new Set(["bash", "webSearch"]);
const PI_BUILTIN_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "write",
]);

export type HarnessKind = "claude-code" | "codex" | "pi";
export type WorkdirHarnessKind = HarnessKind;

interface HarnessAgentCommonOptions {
  id?: string;
  reservationKey: string;
  bridgePort?: number;
  instructions?: string;
  permissionMode?: HarnessAgentPermissionMode;
  sandboxConfig?: HarnessAgentSandboxConfig;
  skills?: ReadonlyArray<HarnessAgentSkill>;
  toolApproval?: HarnessAgentToolApprovalConfiguration;
  tools?: ToolSet;
}

export type WorkdirHarnessAgentOptions =
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "sandbox";
        persistent: true;
      };
      harness: "claude-code";
      harnessSettings?: ClaudeCodeHarnessSettings;
    })
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "sandbox";
        persistent: true;
      };
      harness: "codex";
      harnessSettings?: CodexHarnessSettings;
    })
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "sandbox";
        persistent: true;
      };
      harness: "pi";
      harnessSettings?: PiHarnessSettings;
    });

export type MicrovmHarnessAgentOptions =
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "lambda";
        persistent: true;
      };
      harness: "claude-code";
      harnessSettings?: ClaudeCodeHarnessSettings;
    })
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "lambda";
        persistent: true;
      };
      harness: "codex";
      harnessSettings?: CodexHarnessSettings;
    })
  | (HarnessAgentCommonOptions & {
      compute: SandboxExecutorConfig & {
        provider: "lambda";
        persistent: true;
      };
      harness: "pi";
      harnessSettings?: PiHarnessSettings;
    });

export interface HarnessAgentRuntime {
  agent: HarnessAgent<any, any>;
  bridgePort: number;
  reservationKey: string;
  sandbox: ReturnType<typeof createBroodsSandbox>;
}

export type WorkdirHarnessAgentRuntime = HarnessAgentRuntime;
export type MicrovmHarnessAgentRuntime = HarnessAgentRuntime;

export interface ConfiguredHarnessAgentOptions {
  agentConfig: AgentConfig;
  compute: SandboxExecutorConfig;
  instructions: string;
  reservationKey: string;
  toolApproval?: HarnessAgentToolApprovalConfiguration;
  tools: ToolSet;
}

export function createConfiguredHarnessAgent(
  options: ConfiguredHarnessAgentOptions,
): HarnessAgentRuntime {
  const harness = options.agentConfig.harness;
  if (!harness) {
    throw new Error("config.harness is required");
  }
  const compute = requireHarnessCompute(options.compute);
  const common = {
    compute: compute,
    harness: harness.kind,
    harnessSettings: resolveHarnessSettings(options.agentConfig),
    instructions: options.instructions,
    permissionMode: harness.permissionMode,
    reservationKey: options.reservationKey,
    toolApproval: options.toolApproval,
    tools: withoutHarnessBuiltinTools(options.tools, harness.kind),
  } as const;

  return compute.provider === "sandbox"
    ? createWorkdirHarnessAgent({
        ...common,
        compute: compute,
      } as WorkdirHarnessAgentOptions)
    : createMicrovmHarnessAgent({
        ...common,
        compute: compute,
      } as MicrovmHarnessAgentOptions);
}

export function createWorkdirHarnessAgent(
  options: WorkdirHarnessAgentOptions,
): WorkdirHarnessAgentRuntime {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const reservationKey = versionScopedReservationKey(
    options.reservationKey,
    options.harness,
  );
  const compute = {
    ...options.compute,
    onCreate: [ENSURE_PNPM_COMMAND, ...(options.compute.onCreate ?? [])],
  };
  const sandbox = createBroodsSandbox({
    driver: createWorkdirHarnessDriver({
      reservationKey,
      config: compute,
      ports: [bridgePort],
    }),
    providerId: `broods-workdir-${options.harness}`,
    bridgePorts: [bridgePort],
  });
  const agent = createHarnessAgent(options, sandbox);

  return { agent, bridgePort, reservationKey, sandbox };
}

export function createMicrovmHarnessAgent(
  options: MicrovmHarnessAgentOptions,
): MicrovmHarnessAgentRuntime {
  const bridgePort = options.bridgePort ?? DEFAULT_HARNESS_BRIDGE_PORT;
  const reservationKey = versionScopedReservationKey(
    options.reservationKey,
    options.harness,
  );
  const compute = {
    ...options.compute,
    onCreate: [
      ENSURE_HARNESS_WORKSPACE_COMMAND,
      ENSURE_PNPM_COMMAND,
      ...(options.compute.onCreate ?? []),
    ],
  };
  const sandbox = createBroodsSandbox({
    driver: createMicrovmHarnessDriver({
      reservationKey,
      config: compute,
      ports: [bridgePort],
    }),
    providerId: `broods-microvm-${options.harness}`,
    bridgePorts: [bridgePort],
  });
  const agent = createHarnessAgent(options, sandbox);

  return { agent, bridgePort, reservationKey, sandbox };
}

export function workdirHarnessVersion(kind: WorkdirHarnessKind): string {
  return harnessVersion(kind);
}

export function microvmHarnessVersion(kind: HarnessKind): string {
  return harnessVersion(kind);
}

function harnessVersion(kind: HarnessKind): string {
  if (kind === "claude-code") {
    return CLAUDE_CODE_HARNESS_VERSION;
  }
  if (kind === "codex") {
    return CODEX_HARNESS_VERSION;
  }

  return PI_HARNESS_VERSION;
}

function versionScopedReservationKey(
  reservationKey: string,
  kind: HarnessKind,
): string {
  return `${reservationKey}:${kind}:${harnessVersion(kind)}`;
}

function createHarnessAgent(
  options: WorkdirHarnessAgentOptions | MicrovmHarnessAgentOptions,
  sandbox: ReturnType<typeof createBroodsSandbox>,
): HarnessAgent<any, any> {
  const harness =
    options.harness === "claude-code"
      ? createClaudeCode(options.harnessSettings)
      : options.harness === "codex"
        ? createCodex(options.harnessSettings)
        : createPi(options.harnessSettings);

  if (
    options.harness === "codex" &&
    options.permissionMode !== undefined &&
    options.permissionMode !== "allow-all"
  ) {
    throw new Error("Codex Harness requires permissionMode allow-all");
  }

  return new HarnessAgent({
    harness,
    sandbox,
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {}),
    ...(options.permissionMode !== undefined
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(options.sandboxConfig !== undefined
      ? { sandboxConfig: options.sandboxConfig }
      : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
    ...(options.toolApproval !== undefined
      ? { toolApproval: options.toolApproval }
      : {}),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
  });
}

function withoutHarnessBuiltinTools(
  tools: ToolSet,
  kind: HarnessKind,
): ToolSet {
  const builtinNames =
    kind === "claude-code"
      ? CLAUDE_CODE_BUILTIN_TOOL_NAMES
      : kind === "codex"
        ? CODEX_BUILTIN_TOOL_NAMES
        : PI_BUILTIN_TOOL_NAMES;

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !builtinNames.has(name)),
  );
}

function requireHarnessCompute(
  compute: SandboxExecutorConfig,
):
  | (SandboxExecutorConfig & { provider: "sandbox"; persistent: true })
  | (SandboxExecutorConfig & { provider: "lambda"; persistent: true }) {
  if (
    (compute.provider !== "sandbox" && compute.provider !== "lambda") ||
    compute.persistent !== true
  ) {
    throw new Error(
      "config.harness requires a persistent sandbox using the sandbox or lambda provider",
    );
  }

  return compute as
    | (SandboxExecutorConfig & { provider: "sandbox"; persistent: true })
    | (SandboxExecutorConfig & { provider: "lambda"; persistent: true });
}

function requireHarnessProviderSettings(
  agentConfig: AgentConfig,
  providerName: NonNullable<AgentConfig["model"]>["provider"] & string,
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

function requireHarnessModelId(agentConfig: AgentConfig): string {
  const modelId = agentConfig.model?.modelId;
  if (!modelId) {
    throw new Error("config.model.modelId is required for config.harness");
  }

  return modelId;
}

function resolveHarnessSettings(
  agentConfig: AgentConfig,
): ClaudeCodeHarnessSettings | CodexHarnessSettings | PiHarnessSettings {
  const harness = agentConfig.harness;
  if (!harness) {
    throw new Error("config.harness is required");
  }
  const model = requireHarnessModelId(agentConfig);
  const providerName = agentConfig.model?.provider;
  if (!providerName) {
    throw new Error("config.model.provider is required for config.harness");
  }
  const provider = requireHarnessProviderSettings(agentConfig, providerName);
  if (harness.kind === "claude-code") {
    if (providerName !== "anthropic" && providerName !== "gateway") {
      throw new Error(
        "config.harness.kind claude-code requires the anthropic or gateway model provider",
      );
    }
    const auth =
      providerName === "anthropic"
        ? {
            anthropic: {
              apiKey: provider.apiKey,
              ...(provider.base_url || provider.baseURL
                ? { baseUrl: provider.base_url ?? provider.baseURL }
                : {}),
            },
          }
        : {
            gateway: {
              apiKey: provider.apiKey,
              ...(provider.base_url || provider.baseURL
                ? { baseUrl: provider.base_url ?? provider.baseURL }
                : {}),
            },
          };

    return {
      auth: auth,
      maxTurns: agentConfig.agent?.maxTurn,
      model: model,
      startupTimeoutMs: harness.startupTimeoutMs,
    };
  }
  if (
    harness.kind === "codex" &&
    providerName !== "custom" &&
    providerName !== "openai" &&
    providerName !== "gateway"
  ) {
    throw new Error(
      "config.harness.kind codex requires the custom, openai, or gateway model provider",
    );
  }
  if (harness.kind === "pi") {
    const prefix =
      providerName === "gateway"
        ? "AI_GATEWAY"
        : providerName === "custom"
          ? (provider.name ?? "custom")
              .replace(/[^A-Za-z0-9]+/g, "_")
              .toUpperCase()
          : providerName.toUpperCase();
    const auth =
      providerName === "gateway"
        ? {
            gateway: {
              apiKey: provider.apiKey,
              ...(provider.base_url || provider.baseURL
                ? { baseUrl: provider.base_url ?? provider.baseURL }
                : {}),
            },
          }
        : {
            customEnv: {
              [`${prefix}_API_KEY`]: provider.apiKey,
              ...(provider.base_url || provider.baseURL
                ? {
                    [`${prefix}_BASE_URL`]:
                      provider.base_url ?? provider.baseURL!,
                  }
                : {}),
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

    return {
      auth: auth,
      model: model,
      thinkingLevel: thinkingLevel,
    };
  }
  const auth =
    providerName === "custom"
      ? {
          openaiCompatible: {
            apiKey: provider.apiKey,
            baseUrl: provider.base_url ?? provider.baseURL,
            modelProviderName: provider.name ?? "custom",
          },
        }
      : providerName === "openai"
        ? {
            openai: {
              apiKey: provider.apiKey,
              ...(provider.base_url || provider.baseURL
                ? { baseUrl: provider.base_url ?? provider.baseURL }
                : {}),
              organization: provider.organization,
              project: provider.project,
            },
          }
        : {
            gateway: {
              apiKey: provider.apiKey,
              ...(provider.base_url || provider.baseURL
                ? { baseUrl: provider.base_url ?? provider.baseURL }
                : {}),
            },
          };
  const reasoning = agentConfig.model?.reasoning;
  const reasoningEffort =
    reasoning === "low" || reasoning === "medium" || reasoning === "high"
      ? reasoning
      : undefined;

  return {
    auth: auth,
    model: model,
    reasoningEffort: reasoningEffort,
    startupTimeoutMs: harness.startupTimeoutMs,
    webSearch: harness.webSearch,
  };
}
