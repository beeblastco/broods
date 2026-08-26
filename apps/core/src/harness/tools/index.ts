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
  resolveSubagentMode,
  type AccountModelProviderName,
  type AgentConfig,
  type AgentToolConfig,
} from "../../shared/domain/agent-config.ts";
import type { SandboxPermissionMode } from "../../shared/domain/sandbox-config.ts";
import { workspaceMemoryHarnessEnabled } from "../../shared/domain/workspace-config.ts";
import { logWarn } from "../../shared/log.ts";
import { publicConversationKeyFromScoped } from "../../shared/runtime-keys.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { getStorage } from "../../shared/storage.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type {
  AsyncToolModeMap,
  AsyncToolSource,
  RunAsyncToolDispatch,
} from "../async-tools.ts";
import type { RunSessionMessageDispatch } from "../ingress.ts";
import type {
  SandboxCpuSample,
  SandboxExecutorConfig,
} from "../sandbox/types.ts";
import type { Session } from "../session.ts";
import accountTool from "./custom.tool.ts";
import asyncStatusTool from "./async-status.tool.ts";
import bashTool from "./bash.tool.ts";
import {
  sendFilesTool,
  sendImagesTool,
  sendMessageTool,
  sendReactionsTool,
  sendStickerTool,
  type ChannelToolContext,
} from "./channel.tool.ts";
import editTool from "./edit.tool.ts";
import {
  hasStandaloneSandbox,
  sandboxSupportsBackgroundJobs,
  sandboxSupportsJobControls,
} from "./filesystem-utils.ts";
import globTool from "./glob.tool.ts";
import getSubagentStatusTool from "./get-subagent-status.tool.ts";
import grepTool from "./grep.tool.ts";
import loadSkillTool from "./load-skill.tool.ts";
import { createConnectorTools } from "../connectors.ts";
import { createSelfConfigTools } from "./self-config.tool.ts";
import memoryTool from "./memory.tool.ts";
import { providerDefinedTool } from "./provider-tool.ts";
import readTool from "./read.tool.ts";
import runSubagentTool, {
  type RunSubagentDispatch,
} from "./run-subagent.tool.ts";
import {
  cancelScheduleTool,
  listSchedulesTool,
  scheduleTool,
  updateScheduleTool,
  type ScheduleContext,
} from "./schedule.tool.ts";
import stopSubagentTool from "./stop-subagent.tool.ts";
import updateSubagentTool from "./update-subagent.tool.ts";
import writeTool from "./write.tool.ts";

// Runtime dependencies shared by tool factories. Model-facing input schemas
// stay inside each individual tool file.
export interface ToolContext {
  accountId?: string;
  conversationKey: string;
  // Each workspace carries its own effective sandbox + permissionMode (or no
  // sandbox => read-only). See resolveAgentRuntime.
  workspaces?: ResolvedWorkspace[];
  // The agent's own sandbox (`config.sandbox`). Backs bash outright when no
  // workspace is attached, and stays reachable as its own bash target when the
  // attached workspaces all borrow a different sandbox. Undefined => no own sandbox.
  agentSandbox?: SandboxExecutorConfig;
  agentSandboxPermissionMode?: SandboxPermissionMode;
  config: AgentToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
  session?: Session;
  dispatchSubagents?: RunSubagentDispatch;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  dispatchSessionMessage?: RunSessionMessageDispatch;
  // Reports each sandbox exec's CPU so the harness attributes usage per sandbox
  // (agent bash/fs => role "agent"; uploaded custom tools => role "tool").
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  sandboxMetadata?: SandboxRunMetadata;
  approvalRequirements?: Map<string, true>;
  policyToolIdsByName?: Map<string, string>;
  channel?: ChannelToolContext;
}

export async function createTools(
  context: Omit<ToolContext, "config">,
  agentConfig: AgentConfig,
): Promise<ToolSet> {
  const tools: ToolSet = {};

  // Sandbox tool surface. Tool availability is derived per workspace:
  //  - bash: the agent's own sandbox (no workspace, or the standalone target),
  //    or in any sandbox-backed workspace.
  //  - read/glob: every workspace (sandbox-backed via the mount, read-only
  //    workspaces straight from S3).
  //  - write/edit/grep: sandbox-backed workspaces only.
  // Per-call sandbox approval is handled by the harness-level v7 toolApproval.
  const workspaces = context.workspaces ?? [];
  const sandboxWorkspaces = workspaces.filter((workspace) => workspace.sandbox);
  const agentSandbox = context.agentSandbox;
  const sandboxOptions =
    typeof agentSandbox?.options === "object" && agentSandbox.options !== null
      ? (agentSandbox.options as Record<string, unknown>)
      : {};
  const hasSandboxReservation =
    typeof sandboxOptions.reservationKey === "string" &&
    sandboxOptions.reservationKey.trim().length > 0;
  // Persistence is keyed by workspace namespace, so a run that reaches the sandbox
  // without one needs an explicit options.reservationKey to reconnect.
  const runsWithoutNamespace =
    workspaces.length === 0 || hasStandaloneSandbox(workspaces, agentSandbox);
  if (
    agentSandbox?.persistent === true &&
    runsWithoutNamespace &&
    !hasSandboxReservation
  ) {
    logWarn(
      "persistent sandbox reachable without a workspace; those runs are ephemeral",
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

  // bash: the agent's own sandbox, or any sandbox-backed workspace.
  // Pass the full workspace list so omitting `workspace` preserves the configured
  // default; if that default is read-only, the tool returns a clear error instead
  // of silently selecting the first writable workspace.
  if (agentSandbox || sandboxWorkspaces.length > 0) {
    Object.assign(
      sandboxTools,
      bashTool({
        workspaces: workspaces,
        ...(agentSandbox
          ? {
              agentSandbox: agentSandbox,
              agentSandboxPermissionMode:
                context.agentSandboxPermissionMode ?? "ask",
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
      readTool({ workspaces: workspaces }),
      globTool({ workspaces: workspaces }),
    );
  }
  // write/edit/grep: require a sandbox at execution time. Pass the full workspace
  // list to preserve default-workspace semantics; read-only selections fail clearly.
  if (sandboxWorkspaces.length > 0) {
    const fsContext = {
      workspaces: workspaces,
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

  if (context.channel) {
    Object.assign(
      tools,
      // send-images and send-files both deliver a workspace file, so they take
      // the same workspace list the sandbox tools read from, plus the account
      // that seals the link.
      sendFilesTool({
        ...context.channel,
        workspaces: workspaces,
        ...(context.accountId ? { accountId: context.accountId } : {}),
      }),
      sendImagesTool({
        ...context.channel,
        workspaces: workspaces,
        ...(context.accountId ? { accountId: context.accountId } : {}),
      }),
      sendReactionsTool(context.channel),
      sendStickerTool(context.channel),
    );
  }
  if (
    context.dispatchSessionMessage &&
    Object.keys(agentConfig.channels ?? {}).length > 0
  ) {
    Object.assign(tools, sendMessageTool(context.dispatchSessionMessage));
  }

  // Subagent execution is orchestrated by the handler/coordinator. The registry
  // exposes only the model-facing tool when config and runtime dispatcher agree.
  if (agentConfig.subagent?.enabled === true && context.dispatchSubagents) {
    Object.assign(
      tools,
      runSubagentTool({
        dispatchSubagents: context.dispatchSubagents,
        mode: resolveSubagentMode(agentConfig),
      }),
    );
    if (
      resolveSubagentMode(agentConfig) === "persistent" &&
      context.accountId &&
      context.session
    ) {
      Object.assign(
        tools,
        getSubagentStatusTool({
          accountId: context.accountId,
          eventId: context.session.eventId,
        }),
        updateSubagentTool({
          accountId: context.accountId,
          eventId: context.session.eventId,
        }),
        stopSubagentTool({
          accountId: context.accountId,
          eventId: context.session.eventId,
        }),
      );
    }
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

  // schedule writes a cron bound to this conversation, so a scheduled run
  // resumes the same session and replies wherever this one does.
  // list/update/cancel reach every task of this agent, whichever conversation
  // created it. A run the scheduler started gets none of them: it reads its own
  // stored instructions as a fresh request, so each one acts on its own schedule.
  if (
    agentConfig.scheduler?.enabled === true &&
    context.accountId &&
    context.session?.agentId &&
    context.session.trigger !== "cron"
  ) {
    const accountId = context.accountId;
    const agentId = context.session.agentId;
    const scheduledTaskContext: ScheduleContext = {
      accountId: accountId,
      agentId: agentId,
      conversationKey: publicConversationKeyFromScoped(
        context.conversationKey,
        accountId,
        agentId,
      ),
    };
    Object.assign(
      tools,
      cancelScheduleTool(scheduledTaskContext),
      listSchedulesTool(scheduledTaskContext),
      scheduleTool(scheduledTaskContext),
      updateScheduleTool(scheduledTaskContext),
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
        accountId: accountId,
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
        workspaces: workspaces,
        // logs/stop only apply when the background provider exposes live controls.
        supportsJobs: workspaces.some((workspace) =>
          sandboxSupportsJobControls(workspace.sandbox),
        ),
      }),
    );
  }

  // Connector tools (ticket 19): enabled connectors resolve into live MCP or
  // provider tools. Failures degrade to absence, never a crashed run; deny
  // lists below still cover them because this runs before withholdTools.
  Object.assign(
    tools,
    await createConnectorTools(context.accountId, agentConfig.connectors),
  );

  // Self-configuration toolset (ticket 21): only when the session is an owner
  // session — the dashboard's internal test endpoint with account auth plus
  // the owner-session marker. Channel, public, and cron runs never see these
  // (the marker seam in owner-session.ts refuses every other auth kind, and
  // the handler clears it on cron triggers).
  if (context.session?.ownerSession === true && context.accountId) {
    Object.assign(
      tools,
      createSelfConfigTools(
        {
          accountId: context.accountId,
          ...(context.session.agentId
            ? { agentId: context.session.agentId }
            : {}),
          ...(context.workspaces ? { workspaces: context.workspaces } : {}),
        },
        agentConfig,
      ),
    );
  }

  // Withhold last, so a channel's deny list covers sandbox and account tools too
  // — those are derived from workspaces and ids, never from config.tools.
  withholdTools(tools, agentConfig.denyTools);

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncModes)
    : tools;
}

function withholdTools(tools: ToolSet, denyTools: string[] | undefined): void {
  for (const toolName of denyTools ?? []) {
    if (toolName in tools) {
      delete tools[toolName];
    }
  }
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
