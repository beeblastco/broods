/**
 * HarnessAgent construction over Broods-owned persistent sandboxes.
 */

import {
  HarnessAgent,
  type HarnessAgentAdapter,
  type HarnessAgentPermissionMode,
  type HarnessAgentSkill,
  type HarnessAgentToolApprovalConfiguration,
  type HarnessDiagnostic,
} from "@ai-sdk/harness/agent";
import type { ToolSet } from "ai";
import type {
  AgentConfig,
  AgentHarnessDebugConfig,
} from "../../shared/domain/agent-config.ts";
import { logDebug, logError, logInfo, logWarn } from "../../shared/log.ts";
import type { SandboxExecutorConfig } from "../sandbox/types.ts";
import {
  createAiSdkHarnessAdapter,
  createConfiguredAiSdkHarnessAdapter,
  type AiSdkHarnessSettings,
  type AiSdkHarnessType,
} from "./adapters/index.ts";
import {
  createAiSdkHarnessSandbox,
  requireAiSdkHarnessCompute,
  type AiSdkHarnessCompute,
  type AiSdkHarnessSandbox,
} from "./sandbox.ts";

interface HarnessAgentCommonOptions {
  activeTools?: string[];
  adapter: HarnessAgentAdapter;
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
  type: AiSdkHarnessType;
}

type HarnessToolFiltering =
  | { activeTools: string[]; inactiveTools?: never }
  | { activeTools?: never; inactiveTools: string[] }
  | { activeTools?: never; inactiveTools?: never };

export interface WorkdirHarnessAgentOptions extends Omit<
  HarnessAgentCommonOptions,
  "adapter"
> {
  compute: SandboxExecutorConfig & {
    provider: "sandbox";
    persistent: true;
  };
  harnessSettings?: AiSdkHarnessSettings;
}

export interface MicrovmHarnessAgentOptions extends Omit<
  HarnessAgentCommonOptions,
  "adapter"
> {
  compute: SandboxExecutorConfig & {
    provider: "lambda";
    persistent: true;
  };
  harnessSettings?: AiSdkHarnessSettings;
}

export interface AiSdkHarnessRuntime {
  agent: HarnessAgent;
  bridgePort: number;
  reservationKey: string;
  sandbox: AiSdkHarnessSandbox["sandbox"];
}

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
): AiSdkHarnessRuntime {
  const harness = options.agentConfig.harness;
  if (!harness) {
    throw new Error("config.harness is required");
  }
  const compute = requireAiSdkHarnessCompute(options.compute);
  const common = {
    ...resolveHarnessToolFiltering(options.agentConfig),
    adapter: createConfiguredAiSdkHarnessAdapter(options.agentConfig),
    debug: harness.debug,
    id: options.id,
    instructions: options.instructions,
    permissionMode: harness.permissionMode,
    reservationKey: options.reservationKey,
    skills: options.skills,
    toolApproval: options.toolApproval,
    tools: options.tools,
    type: harness.type,
  };

  return createHarnessRuntime({
    ...common,
    compute: compute,
  });
}

export function createMicrovmHarnessAgent(
  options: MicrovmHarnessAgentOptions,
): AiSdkHarnessRuntime {
  return createHarnessRuntime({
    ...options,
    adapter: createAiSdkHarnessAdapter(options.type, options.harnessSettings),
  });
}

export function createWorkdirHarnessAgent(
  options: WorkdirHarnessAgentOptions,
): AiSdkHarnessRuntime {
  return createHarnessRuntime({
    ...options,
    adapter: createAiSdkHarnessAdapter(options.type, options.harnessSettings),
  });
}

function createHarnessAgent(
  options: HarnessAgentCommonOptions,
  sandbox: AiSdkHarnessSandbox["sandbox"],
): HarnessAgent {
  if (
    options.type === "codex" &&
    options.permissionMode !== undefined &&
    options.permissionMode !== "allow-all"
  ) {
    throw new Error("Codex Harness requires permissionMode allow-all");
  }
  const tools = withoutHarnessBuiltinTools(
    options.tools ?? {},
    options.adapter,
  );

  const settings = {
    harness: options.adapter,
    sandbox: sandbox,
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.id !== undefined ? { id: options.id } : {}),
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
      functionId: `harness.${options.type}`,
      recordInputs: false,
      recordOutputs: false,
    },
    tools: tools,
  };
  if (options.activeTools !== undefined) {
    return new HarnessAgent<HarnessAgentAdapter, ToolSet>({
      ...settings,
      activeTools: options.activeTools,
    });
  }
  if (options.inactiveTools !== undefined) {
    return new HarnessAgent<HarnessAgentAdapter, ToolSet>({
      ...settings,
      inactiveTools: options.inactiveTools,
    });
  }

  return new HarnessAgent<HarnessAgentAdapter, ToolSet>(settings);
}

function createHarnessRuntime(
  options: HarnessAgentCommonOptions & {
    compute: AiSdkHarnessCompute;
  },
): AiSdkHarnessRuntime {
  const provisioned = createAiSdkHarnessSandbox({
    bridgePort: options.bridgePort,
    compute: options.compute,
    reservationKey: options.reservationKey,
    type: options.type,
  });
  const agent = createHarnessAgent(options, provisioned.sandbox);

  return {
    agent: agent,
    bridgePort: provisioned.bridgePort,
    reservationKey: provisioned.reservationKey,
    sandbox: provisioned.sandbox,
  };
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

function resolveHarnessToolFiltering(
  agentConfig: AgentConfig,
): HarnessToolFiltering {
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

function withoutHarnessBuiltinTools(
  tools: ToolSet,
  harness: HarnessAgentAdapter,
): ToolSet {
  const builtinNames = new Set(Object.keys(harness.builtinTools));

  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !builtinNames.has(name)),
  );
}
