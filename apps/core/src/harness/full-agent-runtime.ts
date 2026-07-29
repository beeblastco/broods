/**
 * Full-agent adapter construction over Broods-owned persistent sandboxes.
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
  VERSION as DEEP_AGENTS_HARNESS_VERSION,
  createDeepAgents,
  type DeepAgentsHarnessSettings,
} from "@ai-sdk/harness-deepagents";
import {
  VERSION as OPENCODE_HARNESS_VERSION,
  createOpenCode,
  type OpenCodeHarnessSettings,
} from "@ai-sdk/harness-opencode";
import {
  VERSION as PI_HARNESS_VERSION,
  createPi,
  type PiHarnessSettings,
} from "@ai-sdk/harness-pi";
import {
  HarnessAgent,
  type HarnessAgentAdapter,
  type HarnessAgentPermissionMode,
  type HarnessAgentSkill,
  type HarnessAgentToolApprovalConfiguration,
  type HarnessDiagnostic,
} from "@ai-sdk/harness/agent";
import { createBroodsSandbox } from "@broods/ai-sdk-sandbox";
import type { ToolSet } from "ai";
import type {
  AgentConfig,
  AgentHarnessDebugConfig,
  AgentProviderSettings,
} from "../shared/domain/agent-config.ts";
import { logDebug, logError, logInfo, logWarn } from "../shared/log.ts";
import { createMicrovmHarnessDriver } from "./sandbox/microvm-harness-driver.ts";
import type { SandboxExecutorConfig } from "./sandbox/types.ts";
import { createWorkdirHarnessDriver } from "./sandbox/workdir-harness-driver.ts";

const DEFAULT_HARNESS_BRIDGE_PORT = 4_321;
const ENSURE_PNPM_COMMAND =
  "command -v pnpm >/dev/null 2>&1 || npm install --global pnpm@10.34.5 --no-audit --no-fund";
const ENSURE_HARNESS_WORKSPACE_COMMAND = "mkdir -p /workspace";

export type HarnessType =
  "claude-code" | "codex" | "deepagents" | "opencode" | "pi";
export type WorkdirHarnessType = HarnessType;

interface HarnessAgentCommonOptions {
  activeTools?: string[];
  bridgePort?: number;
  debug?: AgentHarnessDebugConfig;
  id?: string;
  inactiveTools?: string[];
  instructions?: string;
  permissionMode?: HarnessAgentPermissionMode;
  reservationKey: string;
  skills?: ReadonlyArray<HarnessAgentSkill>;
  toolApproval?: HarnessAgentToolApprovalConfiguration;
  tools?: ToolSet;
}

type HarnessSettings =
  | ClaudeCodeHarnessSettings
  | CodexHarnessSettings
  | DeepAgentsHarnessSettings
  | OpenCodeHarnessSettings
  | PiHarnessSettings;

export interface WorkdirHarnessAgentOptions extends HarnessAgentCommonOptions {
  compute: SandboxExecutorConfig & {
    provider: "sandbox";
    persistent: true;
  };
  harness: HarnessType;
  harnessSettings?: HarnessSettings;
}

export interface MicrovmHarnessAgentOptions extends HarnessAgentCommonOptions {
  compute: SandboxExecutorConfig & {
    provider: "lambda";
    persistent: true;
  };
  harness: HarnessType;
  harnessSettings?: HarnessSettings;
}

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
  id?: string;
  instructions: string;
  reservationKey: string;
  skills?: ReadonlyArray<HarnessAgentSkill>;
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
  if (harness.type === "default") {
    throw new Error(
      "config.harness.type default uses the Broods serverless agent loop",
    );
  }
  const compute = requireHarnessCompute(options.compute);
  const toolFiltering = resolveHarnessToolFiltering(options.agentConfig);
  const common = {
    ...toolFiltering,
    compute: compute,
    debug: harness.debug,
    harness: harness.type as HarnessType,
    harnessSettings: resolveHarnessSettings(options.agentConfig),
    id: options.id,
    instructions: options.instructions,
    permissionMode: harness.permissionMode,
    reservationKey: options.reservationKey,
    skills: options.skills,
    toolApproval: options.toolApproval,
    tools: options.tools,
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

export function workdirHarnessVersion(type: WorkdirHarnessType): string {
  return harnessVersion(type);
}

export function microvmHarnessVersion(type: HarnessType): string {
  return harnessVersion(type);
}

function createHarnessAdapter(
  options: WorkdirHarnessAgentOptions | MicrovmHarnessAgentOptions,
): HarnessAgentAdapter {
  if (options.harness === "claude-code") {
    return createClaudeCode(
      options.harnessSettings as ClaudeCodeHarnessSettings | undefined,
    );
  }
  if (options.harness === "codex") {
    return createCodex(
      options.harnessSettings as CodexHarnessSettings | undefined,
    );
  }
  if (options.harness === "deepagents") {
    return createDeepAgents(
      options.harnessSettings as DeepAgentsHarnessSettings | undefined,
    );
  }
  if (options.harness === "opencode") {
    return createOpenCode(
      options.harnessSettings as OpenCodeHarnessSettings | undefined,
    );
  }

  return createPi(options.harnessSettings as PiHarnessSettings | undefined);
}

function harnessVersion(type: HarnessType): string {
  if (type === "claude-code") {
    return CLAUDE_CODE_HARNESS_VERSION;
  }
  if (type === "codex") {
    return CODEX_HARNESS_VERSION;
  }
  if (type === "deepagents") {
    return DEEP_AGENTS_HARNESS_VERSION;
  }
  if (type === "opencode") {
    return OPENCODE_HARNESS_VERSION;
  }

  return PI_HARNESS_VERSION;
}

function logHarnessDiagnostic(diagnostic: HarnessDiagnostic): void {
  const data = {
    eventType: "harness.diagnostic",
    attrs: diagnostic.attrs,
    error: diagnostic.error,
    harnessDiagnosticKind: diagnostic.kind,
    sessionId: diagnostic.sessionId,
    source: diagnostic.source,
    stream: diagnostic.stream,
    subsystem: diagnostic.subsystem,
  };
  if (diagnostic.level === "error") {
    logError(diagnostic.message, data);
  } else if (diagnostic.level === "warn") {
    logWarn(diagnostic.message, data);
  } else if (diagnostic.level === "info") {
    logInfo(diagnostic.message, data);
  } else {
    logDebug(diagnostic.message, data);
  }
}

function resolveHarnessToolFiltering(agentConfig: AgentConfig): {
  activeTools?: string[];
  inactiveTools?: string[];
} {
  const activeTools = agentConfig.harness?.activeTools;
  const inactiveTools = [
    ...(agentConfig.harness?.inactiveTools ?? []),
    ...(agentConfig.denyTools ?? []),
  ];
  if (activeTools) {
    const denied = new Set(agentConfig.denyTools ?? []);

    return {
      activeTools: activeTools.filter((toolName) => !denied.has(toolName)),
    };
  }

  return inactiveTools.length > 0
    ? { inactiveTools: [...new Set(inactiveTools)] }
    : {};
}

function versionScopedReservationKey(
  reservationKey: string,
  type: HarnessType,
): string {
  return `${reservationKey}:${type}:${harnessVersion(type)}`;
}

function createHarnessAgent(
  options: WorkdirHarnessAgentOptions | MicrovmHarnessAgentOptions,
  sandbox: ReturnType<typeof createBroodsSandbox>,
): HarnessAgent<any, any> {
  const harness = createHarnessAdapter(options);

  if (
    options.harness === "codex" &&
    options.permissionMode !== undefined &&
    options.permissionMode !== "allow-all"
  ) {
    throw new Error("Codex Harness requires permissionMode allow-all");
  }
  const tools = withoutHarnessBuiltinTools(options.tools ?? {}, harness);

  return new HarnessAgent({
    harness,
    sandbox,
    ...(options.activeTools !== undefined
      ? { activeTools: options.activeTools as never }
      : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.inactiveTools !== undefined
      ? { inactiveTools: options.inactiveTools as never }
      : {}),
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {}),
    onLog: logHarnessDiagnostic,
    ...(options.permissionMode !== undefined
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
    ...(options.toolApproval !== undefined
      ? { toolApproval: options.toolApproval }
      : {}),
    telemetry: {
      functionId: `harness.${options.harness}`,
      recordInputs: false,
      recordOutputs: false,
    },
    tools: tools,
  });
}

function withoutHarnessBuiltinTools(
  tools: ToolSet,
  harness: HarnessAgentAdapter,
): ToolSet {
  const builtinNames = new Set(Object.keys(harness.builtinTools));

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

function resolveHarnessSettings(agentConfig: AgentConfig): HarnessSettings {
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
  if (harness.type === "claude-code") {
    if (providerName !== "anthropic" && providerName !== "gateway") {
      throw new Error(
        "config.harness.type claude-code requires the anthropic or gateway model provider",
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
  if (harness.type === "deepagents") {
    if (providerName !== "anthropic" && providerName !== "gateway") {
      throw new Error(
        "config.harness.type deepagents requires the anthropic or gateway model provider",
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
      model: model,
      recursionLimit: agentConfig.agent?.maxTurn,
      startupTimeoutMs: harness.startupTimeoutMs,
    };
  }
  if (harness.type === "opencode") {
    const auth =
      providerName === "custom"
        ? {
            openaiCompatible: {
              apiKey: provider.apiKey,
              baseUrl: provider.base_url ?? provider.baseURL,
              name: provider.name ?? "custom",
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
          : providerName === "anthropic"
            ? {
                anthropic: {
                  apiKey: provider.apiKey,
                  ...(provider.base_url || provider.baseURL
                    ? { baseUrl: provider.base_url ?? provider.baseURL }
                    : {}),
                },
              }
            : providerName === "gateway"
              ? {
                  gateway: {
                    apiKey: provider.apiKey,
                    ...(provider.base_url || provider.baseURL
                      ? { baseUrl: provider.base_url ?? provider.baseURL }
                      : {}),
                  },
                }
              : undefined;
    if (!auth) {
      throw new Error(
        "config.harness.type opencode requires the anthropic, custom, gateway, or openai model provider",
      );
    }
    const reasoning = agentConfig.model?.reasoning;

    return {
      auth: auth,
      model: model,
      provider:
        providerName === "custom" ? (provider.name ?? "custom") : providerName,
      reasoningVariant:
        reasoning && reasoning !== "none" ? reasoning : undefined,
      startupTimeoutMs: harness.startupTimeoutMs,
    };
  }
  if (
    harness.type === "codex" &&
    providerName !== "custom" &&
    providerName !== "openai" &&
    providerName !== "gateway"
  ) {
    throw new Error(
      "config.harness.type codex requires the custom, openai, or gateway model provider",
    );
  }
  if (harness.type === "pi") {
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
