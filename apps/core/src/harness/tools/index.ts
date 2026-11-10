import type { ToolSet } from "ai";
import {
  harnessToolNameProblem,
  isHarnessToolName,
  isProviderToolName,
} from "@broods/convex/model/agentRules";
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
import type { RunSessionMessageDispatch } from "../ingress.ts";
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
import { mcpSignInTool, mcpToolName, mcpTools } from "../mcp/mcp.tool.ts";
import { sandboxMcpTarget } from "../mcp/sandbox.ts";
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
import { providerToolBuild } from "./provider-tool.ts";
import readTool from "./read.tool.ts";
import {
  runsOnProvider,
  sandboxStandIn,
  type SandboxStandIn,
} from "./sandbox-stand-in.ts";
import runSubagentTool, {
  type RunSubagentDispatch,
} from "./run-subagent.tool.ts";
import type { MessageChild, ParentLink, SubagentWatch } from "./utils.ts";
import {
  cancelScheduleTool,
  listSchedulesTool,
  scheduleTool,
  updateScheduleTool,
  type ScheduleContext,
} from "./schedule.tool.ts";
import messageAgentsTool from "./message-agents.tool.ts";
import stopSubagentTool from "./stop-subagent.tool.ts";
import writeTool from "./write.tool.ts";

const MCP_AUTH_FAILURE_PATTERN =
  /\b401\b|requires authorization|sign in again|has no connection/i;
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
  parentLink?: ParentLink;
  messageChild?: MessageChild;
  dispatchSessionMessage?: RunSessionMessageDispatch;
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  onToolRetry?: (toolCallId: string, waitMs: number) => void;
  onBlockingQuestion?: (question: PendingQuestionSummary) => void;
  onDetachedResult?: (resultId: string) => void;
  sandboxMetadata?: SandboxRunMetadata;
  approvalRequirements?: Map<string, true>;
  sandboxStandIns?: Map<string, SandboxStandIn>;
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
        stopSubagentTool({
          accountId: context.accountId,
          eventId: context.session.eventId,
          conversationKey: context.session.conversationKey,
        }),
      );
    }
  }

  // message-agents: a persistent-mode parent reaches its children, and a
  // persistent child its parent.
  const messageChild =
    agentConfig.subagent?.enabled === true &&
    resolveSubagentMode(agentConfig) === "persistent"
      ? context.messageChild
      : undefined;
  if (messageChild || context.parentLink) {
    Object.assign(
      tools,
      messageAgentsTool({
        ...(messageChild ? { messageChild: messageChild } : {}),
        ...(context.parentLink ? { parent: context.parentLink } : {}),
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

  const standIns = context.sandboxStandIns ?? new Map<string, SandboxStandIn>();
  registerProviderTools(tools, agentConfig, context, {
    sandboxTools: sandboxTools,
    fileContext: sandboxContext,
    standIns: standIns,
  });

  // Needs a delivery to resume on; a subagent has none and a cron-fired run has nobody to answer.
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

  if (hasBackgroundWorkspace) {
    Object.assign(
      tools,
      asyncStatusTool({
        conversationKey: context.conversationKey,
        workspaces: workspaces,
        supportsJobs: workspaces.some((workspace) =>
          sandboxSupportsJobControls(workspace.sandbox),
        ),
        ...(session
          ? {
              onResultRead: (toolCallId: string, resultId: string): void => {
                session.recordToolResultRead(toolCallId, resultId);
              },
            }
          : {}),
      }),
    );
  }

  // Withhold last, so a channel's deny list also covers sandbox and MCP tools.
  withholdTools(tools, agentConfig.denyTools, standIns, sandboxTools);

  return tools;
}

function externalToolRuntimeConfig(config: AgentToolConfig): AgentToolConfig {
  const {
    command: _command,
    enabled: _enabled,
    needsApproval: _needsApproval,
    ...runtimeConfig
  } = config;

  return runtimeConfig;
}

function harnessNameError(toolName: string): string {
  return `config.tools.${toolName} ${harnessToolNameProblem(toolName)}`;
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
          context.session?.userCredential,
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
          const message =
            error instanceof Error ? error.message : String(error);
          logWarn("MCP server tool listing failed; skipping its tools", {
            serverId: serverId,
            serverName: record.name,
            error: message,
          });
          if (
            record.transport === "http" &&
            MCP_AUTH_FAILURE_PATTERN.test(message)
          ) {
            tools[mcpToolName(record.name, "sign_in_needed")] =
              mcpSignInTool(record);
          }

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

// A client-executed provider tool runs as the sandbox tool it stands for, in that tool's place.
function registerProviderTools(
  tools: ToolSet,
  agentConfig: AgentConfig,
  context: Omit<ToolContext, "config">,
  sandbox: {
    sandboxTools: ToolSet;
    fileContext: SandboxToolContext;
    standIns: Map<string, SandboxStandIn>;
  },
): void {
  for (const [toolName, toolConfig] of Object.entries(
    agentConfig.tools ?? {},
  )) {
    if (!isProviderToolName(toolName)) {
      throw new Error(`config.tools.${toolName} is not a supported tool`);
    }
    const harnessName = isHarnessToolName(toolName);
    if (harnessName && toolConfig.type !== "provider") {
      throw new Error(harnessNameError(toolName));
    }
    if (!isToolEnabled(toolConfig)) {
      continue;
    }

    if (toolConfig.needsApproval === true)
      context.approvalRequirements?.set(toolName, true);
    const { args, factory } = providerToolBuild(toolName, {
      ...context,
      config: externalToolRuntimeConfig(toolConfig),
    });
    const built = factory(args);
    // Also replaces a default execute: Anthropic bash runs on the AI SDK's experimental_sandbox.
    const standIn =
      built.type === "provider" &&
      built.isProviderExecuted !== true &&
      !runsOnProvider(built.id, args)
        ? sandboxStandIn(built.id, {
            toolName: toolName,
            command: toolConfig.command,
            sandboxTools: sandbox.sandboxTools,
            fileContext: sandbox.fileContext,
          })
        : undefined;
    const taken = harnessName || Object.hasOwn(tools, toolName);
    if (
      taken &&
      !standIn?.replaces.some((name): boolean => name === toolName)
    ) {
      throw new Error(harnessNameError(toolName));
    }
    if (!standIn) {
      tools[toolName] = built;
      continue;
    }
    for (const replaced of standIn.replaces) delete tools[replaced];
    tools[toolName] = factory({
      ...args,
      execute: standIn.execute.bind(standIn),
    });
    sandbox.standIns.set(toolName, standIn);
  }
}

// A withheld stand-in gives back the Broods tools it replaced that denyTools still allows.
function withholdTools(
  tools: ToolSet,
  denyTools: string[] | undefined,
  standIns: Map<string, SandboxStandIn>,
  sandboxTools: ToolSet,
): void {
  const denied = new Set(denyTools ?? []);
  for (const toolName of Object.keys(tools)) {
    const standIn = standIns.get(toolName);
    const runsAs = standIn?.runsAs ?? [];
    if (
      !denied.has(toolName) &&
      !runsAs.some((name): boolean => denied.has(name))
    ) {
      continue;
    }
    delete tools[toolName];
    standIns.delete(toolName);
    for (const name of standIn?.replaces ?? []) {
      const replaced = sandboxTools[name];
      if (replaced && !denied.has(name)) tools[name] = replaced;
    }
  }
}
