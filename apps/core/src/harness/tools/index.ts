import type { ToolSet } from "ai";
import { isProviderToolName } from "@broods/convex/model/agentRules";
import { browserSandboxRefusal } from "@broods/convex/model/sandboxRules";
import {
  resolveSubagentMode,
  type AccountModelProviderName,
  type AgentConfig,
  type AgentMcpEntry,
  type AgentToolConfig,
} from "../../shared/domain/agent-config.ts";
import type { Tool as RemoteMcpTool } from "@modelcontextprotocol/client";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { workspaceMemoryHarnessEnabled } from "../../shared/domain/workspace-config.ts";
import { logWarn } from "../../shared/log.ts";
import { publicConversationKeyFromScoped } from "../../shared/runtime-keys.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { getStorage } from "../../shared/storage.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../../shared/workspaces.ts";
import type { AsyncToolNames, RunAsyncToolDispatch } from "../async-tools.ts";
import type { RunSessionMessageDispatch } from "../ingress.ts";
import type { DispatchAppliedIngress } from "../integrations.ts";
import type { PendingQuestionSummary } from "../questions.ts";
import type {
  SandboxCpuSample,
  SandboxRunPrincipal,
} from "../sandbox/types.ts";
import type { Session } from "../session.ts";
import {
  listMcpTools,
  mcpConnection,
  type McpConnection,
} from "../mcp/client.ts";
import { mcpTools } from "../mcp/mcp.tool.ts";
import { sandboxMcpTarget } from "../mcp/sandbox.ts";
import askParentTool from "./ask-parent.tool.ts";
import askQuestionsTool from "./ask-questions.tool.ts";
import asyncStatusTool from "./async-status.tool.ts";
import bashTool from "./bash.tool.ts";
import browseTool from "./browse.tool.ts";
import computerTool from "./computer.tool.ts";
import {
  sendFilesTool,
  sendImagesTool,
  sendMessageTool,
  sendReactionsTool,
  sendStickerTool,
  sendUpdateTool,
  type ChannelToolContext,
} from "./channel.tool.ts";
import editTool from "./edit.tool.ts";
import {
  hasStandaloneSandbox,
  machineSandboxes,
  sandboxSupportsBackgroundJobs,
  sandboxSupportsJobControls,
  statelessReservationKeyFor,
  type SandboxToolContext,
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
import type { AskParent, SubagentWatch } from "./utils.ts";
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

interface ResolvedMcpServer {
  serverId: string;
  serverConfig: AgentMcpEntry;
  record: McpRecord;
  connection: McpConnection;
  remoteTools: RemoteMcpTool[];
}

export interface ToolContext {
  accountId?: string;
  conversationKey: string;
  workspaces?: ResolvedWorkspace[];
  sandboxes?: ResolvedAgentSandbox[];
  config: AgentToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
  session?: Session;
  dispatchSubagents?: RunSubagentDispatch;
  subagentWatch?: SubagentWatch;
  askParent?: AskParent;
  dispatchAppliedIngress?: DispatchAppliedIngress;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  dispatchSessionMessage?: RunSessionMessageDispatch;
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  onToolRetry?: (toolCallId: string, waitMs: number) => void;
  onBlockingQuestion?: (question: PendingQuestionSummary) => void;
  onDetachedResult?: (resultId: string) => void;
  sandboxMetadata?: SandboxRunMetadata;
  approvalRequirements?: Map<string, true>;
  policyMcpIdsByName?: Map<string, string>;
  channel?: ChannelToolContext;
}

export async function createTools(
  context: Omit<ToolContext, "config">,
  agentConfig: AgentConfig,
): Promise<ToolSet> {
  const tools: ToolSet = {};

  const workspaces = context.workspaces ?? [];
  const sandboxWorkspaces = workspaces.filter((workspace) => workspace.sandbox);
  const sandboxes = context.sandboxes ?? [];
  const defaultSandbox = sandboxes[0]?.sandbox;
  const sandboxContext: SandboxToolContext = {
    workspaces: workspaces,
    sandboxes: sandboxes,
    ...(context.onSandboxCpu ? { onSandboxCpu: context.onSandboxCpu } : {}),
    principal: (): SandboxRunPrincipal | undefined =>
      context.session?.sandboxPrincipal(),
  };
  const hasSandboxReservation =
    defaultSandbox !== undefined &&
    statelessReservationKeyFor(defaultSandbox) !== undefined;
  const runsWithoutNamespace = hasStandaloneSandbox(sandboxContext);
  if (
    defaultSandbox?.persistent === true &&
    runsWithoutNamespace &&
    !hasSandboxReservation
  ) {
    logWarn(
      "persistent sandbox has no reservation key; workspace-less runs are ephemeral",
      {
        conversationKey: context.conversationKey,
      },
    );
  }
  const sandboxTools: ToolSet = {};

  const hasBackgroundWorkspace = workspaces.some((workspace) =>
    sandboxSupportsBackgroundJobs(workspace.sandbox),
  );
  const backgroundContext =
    hasBackgroundWorkspace && context.session
      ? {
          eventId: context.session.eventId,
          conversationKey: context.conversationKey,
          ...(context.session.delivery
            ? { delivery: context.session.delivery }
            : {}),
          ...(context.onDetachedResult
            ? { onDetachedResult: context.onDetachedResult }
            : {}),
        }
      : undefined;

  // The full list, so an omitted workspace keeps the configured default even when read-only.
  if (sandboxes.length > 0 || sandboxWorkspaces.length > 0) {
    Object.assign(
      sandboxTools,
      bashTool({
        ...sandboxContext,
        ...(backgroundContext ? { background: backgroundContext } : {}),
      }),
    );
  }
  const machines = machineSandboxes(sandboxes);
  if (machines.length > 0) {
    Object.assign(sandboxTools, computerTool(machines));
  }
  if (agentConfig.browser?.enabled === true) {
    const problem = browserSandboxRefusal(defaultSandbox);
    if (problem) throw new Error(problem);
    Object.assign(sandboxTools, browseTool(sandboxContext));
  }
  if (workspaces.length > 0) {
    Object.assign(
      sandboxTools,
      readTool({ workspaces: workspaces, agentConfig: agentConfig }),
      globTool({ workspaces: workspaces }),
    );
  }
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
  const asyncToolNames: AsyncToolNames = new Set();

  if (context.channel) {
    Object.assign(
      tools,
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
      sendUpdateTool(context.channel),
    );
  }
  if (
    context.dispatchSessionMessage &&
    Object.keys(agentConfig.channels ?? {}).length > 0
  ) {
    Object.assign(tools, sendMessageTool(context.dispatchSessionMessage));
  }

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
        updateSubagentTool({
          accountId: context.accountId,
          agentConfig: agentConfig,
          dispatchAppliedIngress: context.dispatchAppliedIngress,
          eventId: context.session.eventId,
          conversationKey: context.session.conversationKey,
          session: context.session,
          ...(context.subagentWatch ? { watch: context.subagentWatch } : {}),
        }),
        stopSubagentTool({
          accountId: context.accountId,
          eventId: context.session.eventId,
          conversationKey: context.session.conversationKey,
        }),
      );
    }
  }

  if (context.askParent) {
    Object.assign(tools, askParentTool(context.askParent));
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

  // None on a cron run: it reads its instructions as a fresh request and would schedule again.
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

  for (const [toolName, toolConfig] of Object.entries(
    agentConfig.tools ?? {},
  )) {
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
    if (toolConfig.async === true) asyncToolNames.add(toolName);
  }

  // Needs a delivery to resume on; a cron-fired run has nobody to answer.
  const session = context.session;
  if (session?.delivery !== undefined && session.trigger !== "cron") {
    Object.assign(
      tools,
      askQuestionsTool({
        conversationKey: context.conversationKey,
        eventId: session.eventId,
        delivery: session.delivery,
        ...(context.channel ? { channel: context.channel } : {}),
        ...(context.onBlockingQuestion
          ? { onBlockingQuestion: context.onBlockingQuestion }
          : {}),
        ...(context.onDetachedResult
          ? { onDetachedResult: context.onDetachedResult }
          : {}),
      }),
    );
  }

  await registerMcpTools(tools, agentConfig, context);

  if (asyncToolNames.size > 0 || hasBackgroundWorkspace) {
    Object.assign(
      tools,
      asyncStatusTool({
        conversationKey: context.conversationKey,
        workspaces: workspaces,
        supportsJobs: workspaces.some((workspace) =>
          sandboxSupportsJobControls(workspace.sandbox),
        ),
      }),
    );
  }

  // Withhold last, so a channel's deny list also covers sandbox and MCP tools.
  withholdTools(tools, agentConfig.denyTools);

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncToolNames)
    : tools;
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

export function isToolEnabled<Entry extends { enabled?: boolean }>(
  config: Entry | undefined,
): config is Entry {
  return config !== undefined && config.enabled !== false;
}

async function registerMcpTools(
  tools: ToolSet,
  agentConfig: AgentConfig,
  context: Omit<ToolContext, "config">,
): Promise<void> {
  const entries = Object.entries(agentConfig.mcp ?? {}).filter(
    ([, serverConfig]) => isToolEnabled(serverConfig),
  );
  if (entries.length === 0) return;
  const accountId = context.accountId;
  if (!accountId) {
    throw new Error(
      `config.mcp.${entries[0]![0]} requires an account-scoped session`,
    );
  }

  // Resolved in parallel, merged in config order so name conflicts resolve deterministically.
  const resolved = await Promise.all(
    entries.map(
      async ([serverId, serverConfig]): Promise<ResolvedMcpServer | null> => {
        const record = await getStorage().mcp.getById(accountId, serverId);
        if (!record || record.status !== "active") {
          throw new Error(
            `config.mcp.${serverId} references an unknown MCP server`,
          );
        }
        if (record.disabled) return null;
        const connection = mcpConnection(
          record,
          serverConfig.headers,
          serverConfig.oauth,
          context.session?.principal,
        );
        connection.sandbox = sandboxMcpTarget(record, context);
        // Unreachable degrades to zero tools for this run; the config errors above still throw.
        let listing: RemoteMcpTool[];
        try {
          listing = await listMcpTools(
            connection,
            context.onSandboxCpu
              ? (cpuUsec: number): void =>
                  context.onSandboxCpu!({
                    type: "mcp-sandbox",
                    role: "tool",
                    toolName: record.name,
                    cpuUsec: cpuUsec,
                  })
              : undefined,
          );
        } catch (error) {
          logWarn("MCP server tool listing failed; skipping its tools", {
            serverId: serverId,
            serverName: record.name,
            error: error instanceof Error ? error.message : String(error),
          });

          return null;
        }
        const remoteTools = listing.filter(
          (remote) =>
            !record.allowedTools || record.allowedTools.includes(remote.name),
        );

        return {
          serverId: serverId,
          serverConfig: serverConfig,
          record: record,
          connection: connection,
          remoteTools: remoteTools,
        };
      },
    ),
  );
  for (const server of resolved) {
    if (server === null) continue;
    const serverTools = mcpTools(
      server.connection,
      server.remoteTools,
      context.onSandboxCpu,
      context.onToolRetry,
    );
    if (Object.keys(serverTools).length !== server.remoteTools.length) {
      throw new Error(
        `config.mcp.${server.serverId} has remote tools whose sanitized model-facing names collide`,
      );
    }
    for (const name of Object.keys(serverTools)) {
      if (tools[name]) {
        throw new Error(
          `config.mcp.${server.serverId} model-facing name '${name}' conflicts with another tool`,
        );
      }
      if (server.serverConfig.needsApproval === true)
        context.approvalRequirements?.set(name, true);
      context.policyMcpIdsByName?.set(name, server.serverId);
    }
    Object.assign(tools, serverTools);
  }
}

function withholdTools(tools: ToolSet, denyTools: string[] | undefined): void {
  for (const toolName of denyTools ?? []) {
    if (toolName in tools) {
      delete tools[toolName];
    }
  }
}
