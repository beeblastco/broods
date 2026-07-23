/**
 * Harness tool registry.
 * Keep static tool imports and agent-configured tool selection here.
 *
 * Sandbox tools (bash/read/write/edit/glob/grep) are enabled by the presence of
 * a referenced sandbox + workspaces. Approval is produced as AI SDK v7
 * toolApproval in the harness.
 * Core ships no built-in external tools: a config.tools key is either an
 * uploaded account tool id or a provider-defined tool resolved off the
 * configured AI SDK provider (see provider-tool.ts).
 */

import type { ToolSet } from "ai";
import { isAccountToolId } from "../../shared/domain/account-tools.ts";
import {
  isProviderToolName,
  type AccountModelProviderName,
  type AgentConfig,
  type AgentToolConfig,
} from "../../shared/domain/agent-config.ts";
import type { SandboxPermissionMode } from "../../shared/domain/sandbox-config.ts";
import { workspaceMemoryHarnessEnabled } from "../../shared/domain/workspace-config.ts";
import { logWarn } from "../../shared/log.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { getStorage } from "../../shared/storage.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type {
  AsyncToolModeMap,
  AsyncToolSource,
  RunAsyncToolDispatch,
} from "../async-tools.ts";
import type {
  SandboxCpuSample,
  SandboxExecutorConfig,
} from "../sandbox/types.ts";
import type { Session } from "../session.ts";
import accountTool from "./account-tool.tool.ts";
import asyncStatusTool from "./async-status.tool.ts";
import bashTool from "./bash.tool.ts";
import editTool from "./edit.tool.ts";
import {
  sandboxSupportsBackgroundJobs,
  sandboxSupportsJobControls,
} from "./filesystem-utils.ts";
import globTool from "./glob.tool.ts";
import grepTool from "./grep.tool.ts";
import loadSkillTool from "./load-skill.tool.ts";
import memoryTool from "./memory.tool.ts";
import { providerDefinedTool } from "./provider-tool.ts";
import readTool from "./read.tool.ts";
import runSubagentTool, {
  type RunSubagentDispatch,
} from "./run-subagent.tool.ts";
import writeTool from "./write.tool.ts";

// Runtime dependencies shared by tool factories. Model-facing input schemas
// stay inside each individual tool file.
export interface ToolContext {
  accountId?: string;
  conversationKey: string;
  // Each workspace carries its own effective sandbox + permissionMode (or no
  // sandbox => read-only). See resolveAgentRuntime.
  workspaces?: ResolvedWorkspace[];
  // Agent-level sandbox for stateless bash (no workspace). Undefined => no
  // stateless bash. Workspace-backed runs use the workspace's own sandbox instead.
  statelessSandbox?: SandboxExecutorConfig;
  statelessPermissionMode?: SandboxPermissionMode;
  config: AgentToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
  session?: Session;
  dispatchSubagents?: RunSubagentDispatch;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  // Reports each sandbox exec's CPU so the harness attributes usage per sandbox
  // (agent bash/fs => role "agent"; uploaded custom tools => role "tool").
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  sandboxMetadata?: SandboxRunMetadata;
  approvalRequirements?: Map<string, true>;
  policyToolIdsByName?: Map<string, string>;
}

export async function createTools(
  context: Omit<ToolContext, "config">,
  agentConfig: AgentConfig,
): Promise<ToolSet> {
  const tools: ToolSet = {};

  // Sandbox tool surface. Tool availability is derived per workspace:
  //  - bash: stateless (no workspace) on the agent-level sandbox, or in any
  //    sandbox-backed workspace.
  //  - read/glob: every workspace (sandbox-backed via the mount, read-only
  //    workspaces straight from S3).
  //  - write/edit/grep: sandbox-backed workspaces only.
  // Per-call sandbox approval is handled by the harness-level v7 toolApproval.
  const workspaces = context.workspaces ?? [];
  const sandboxWorkspaces = workspaces.filter((workspace) => workspace.sandbox);
  const statelessSandbox =
    workspaces.length === 0 ? context.statelessSandbox : undefined;
  const statelessOptions =
    typeof statelessSandbox?.options === "object" &&
    statelessSandbox.options !== null
      ? (statelessSandbox.options as Record<string, unknown>)
      : {};
  const hasStatelessReservation =
    typeof statelessOptions.reservationKey === "string" &&
    statelessOptions.reservationKey.trim().length > 0;
  if (statelessSandbox?.persistent === true && !hasStatelessReservation) {
    // Persistence is keyed by workspace namespace; a stateless (no-workspace)
    // sandbox needs an explicit options.reservationKey to reconnect — warn so a
    // misconfiguration is visible rather than silently behaving ephemerally.
    logWarn(
      "persistent sandbox attached without a workspace; it runs ephemerally",
      {
        conversationKey: context.conversationKey,
      },
    );
  }
  const sandboxTools: ToolSet = {};

  // Reserved (persistent) workspaces can run detached background jobs; bash then
  // exposes a `background` flag and records each job under the parent session.
  const hasBackgroundWorkspace = workspaces.some((workspace) =>
    sandboxSupportsBackgroundJobs(workspace.sandbox),
  );
  // eventId identifies the turn that spawned the job (stored as parentEventId on the
  // async-tool-result record); conversationKey identifies which conversation to resume
  // when the job completes in a future continuation worker. delivery carries the
  // originating channel/WebSocket so the result is pushed back there, not just polled.
  const backgroundContext =
    hasBackgroundWorkspace && context.session
      ? {
          eventId: context.session.eventId,
          conversationKey: context.conversationKey,
          ...(context.session.delivery
            ? { delivery: context.session.delivery }
            : {}),
        }
      : undefined;

  // bash: stateless (no workspace) on the agent sandbox, or in any sandbox-backed workspace.
  // Pass the full workspace list so omitting `workspace` preserves the configured
  // default; if that default is read-only, the tool returns a clear error instead
  // of silently selecting the first writable workspace.
  if (statelessSandbox || sandboxWorkspaces.length > 0) {
    Object.assign(
      sandboxTools,
      bashTool({
        workspaces,
        ...(statelessSandbox
          ? {
              statelessSandbox,
              statelessPermissionMode: context.statelessPermissionMode ?? "ask",
            }
          : {}),
        ...(backgroundContext ? { background: backgroundContext } : {}),
        ...(context.onSandboxCpu ? { onSandboxCpu: context.onSandboxCpu } : {}),
      }),
    );
  }
  // read/glob: every workspace (sandbox-backed via the mount, read-only via S3).
  if (workspaces.length > 0) {
    Object.assign(
      sandboxTools,
      readTool({ workspaces }),
      globTool({ workspaces }),
    );
  }
  // write/edit/grep: require a sandbox at execution time. Pass the full workspace
  // list to preserve default-workspace semantics; read-only selections fail clearly.
  if (sandboxWorkspaces.length > 0) {
    const fsContext = {
      workspaces,
      ...(context.onSandboxCpu ? { onSandboxCpu: context.onSandboxCpu } : {}),
    };
    Object.assign(
      sandboxTools,
      writeTool(fsContext),
      editTool(fsContext),
      grepTool(fsContext),
    );
    // memory_save: structured memory on the same sandbox write path. It ships
    // with the workspace harness (config.harness.memory, default on) rather
    // than config.tools, and only touches the memory/ folder and its index.
    if (
      sandboxWorkspaces.some((workspace) =>
        workspaceMemoryHarnessEnabled(workspace.config),
      )
    ) {
      Object.assign(
        sandboxTools,
        memoryTool({ ...fsContext, conversationKey: context.conversationKey }),
      );
    }
  }
  Object.assign(tools, sandboxTools);
  const asyncModes: AsyncToolModeMap = new Map();

  // Subagent execution is orchestrated by the handler/coordinator. The registry
  // exposes only the model-facing tool when config and runtime dispatcher agree.
  if (agentConfig.subagent?.enabled === true && context.dispatchSubagents) {
    Object.assign(
      tools,
      runSubagentTool({
        dispatchSubagents: context.dispatchSubagents,
        mode: agentConfig.subagent.mode,
      }),
    );
  }

  const allowedSkillPaths = agentConfig.skills?.allowed ?? [];
  if (
    agentConfig.skills?.enabled === true &&
    allowedSkillPaths.length > 0 &&
    context.session
  ) {
    Object.assign(
      tools,
      loadSkillTool(context.session, (skillPath, resourcePaths) =>
        context.session!.loadSkillPrompt(
          allowedSkillPaths,
          skillPath,
          resourcePaths,
        ),
      ),
    );
  }

  // Provider-defined tools: every non-account-tool key names a tool the
  // configured provider executes itself, resolved off its `tools` namespace.
  for (const [toolName, toolConfig] of Object.entries(
    agentConfig.tools ?? {},
  ).filter(([key]) => !isAccountToolId(key))) {
    if (!isProviderToolName(toolName)) {
      throw new Error(`config.tools.${toolName} is not a supported tool`);
    }
    if (!isToolEnabled(toolConfig)) {
      continue;
    }

    if (toolConfig.needsApproval === true)
      context.approvalRequirements?.set(toolName, true);
    Object.assign(
      tools,
      providerDefinedTool(toolName, {
        ...context,
        config: externalToolRuntimeConfig(toolConfig),
      }),
    );
    addAsyncModeIfConfigured(asyncModes, toolName, toolConfig, "built-in");
  }

  for (const [toolId, toolConfig] of Object.entries(
    agentConfig.tools ?? {},
  ).filter(([key]) => isAccountToolId(key))) {
    if (!isToolEnabled(toolConfig)) {
      continue;
    }
    if (!context.accountId) {
      throw new Error(
        `config.tools.${toolId} requires an account-scoped session`,
      );
    }
    const accountId = context.accountId;
    const record = await getStorage().accountTools.getById(accountId, toolId);
    if (!record || record.status !== "active") {
      throw new Error(
        `config.tools.${toolId} references an unknown account tool`,
      );
    }
    if (tools[record.name]) {
      throw new Error(
        `config.tools.${toolId} model-facing name '${record.name}' conflicts with another tool`,
      );
    }
    if (toolConfig.needsApproval === true)
      context.approvalRequirements?.set(record.name, true);
    context.policyToolIdsByName?.set(record.name, toolId);
    Object.assign(
      tools,
      accountTool(record, {
        ...context,
        accountId,
        config: externalToolRuntimeConfig(toolConfig),
      }),
    );
    addAsyncModeIfConfigured(asyncModes, record.name, toolConfig, "uploaded");
  }

  // Auto-add the background-job status tool when the agent has any async tool or
  // a reserved sandbox that can launch background jobs.
  if (asyncModes.size > 0 || hasBackgroundWorkspace) {
    Object.assign(
      tools,
      asyncStatusTool({
        conversationKey: context.conversationKey,
        workspaces,
        // logs/stop only apply when the background provider exposes live controls.
        supportsJobs: workspaces.some((workspace) =>
          sandboxSupportsJobControls(workspace.sandbox),
        ),
      }),
    );
  }

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncModes)
    : tools;
}

function isToolEnabled(
  config: AgentToolConfig | undefined,
): config is AgentToolConfig {
  return config !== undefined && config.enabled !== false;
}

function addAsyncModeIfConfigured(
  modes: AsyncToolModeMap,
  modelToolName: string,
  config: AgentToolConfig,
  source: AsyncToolSource,
): void {
  if (config.async === true) {
    modes.set(modelToolName, source);
  }
}

function externalToolRuntimeConfig(config: AgentToolConfig): AgentToolConfig {
  const {
    enabled: _enabled,
    needsApproval: _needsApproval,
    async: _async,
    ...runtimeConfig
  } = config;

  return runtimeConfig;
}
