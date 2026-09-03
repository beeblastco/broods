/**
 * Harness tool registry.
 * Keep static tool imports and agent-configured tool selection here.
 *
 * Sandbox tools (bash/read/write/edit/glob/grep) are enabled by the presence of
 * a referenced sandbox + workspaces. Approval is produced as AI SDK v7
 * toolApproval in the harness.
 * Core ships no built-in external tools: a config.tools key names a
 * provider-defined tool resolved off the configured AI SDK provider (see
 * provider-tool.ts); remote tools come from config.mcp.
 */

import type { ToolSet } from "ai";
import {
  isProviderToolName,
  resolveSubagentMode,
  type AccountModelProviderName,
  type AgentConfig,
  type AgentMcpEntry,
  type AgentToolConfig,
} from "../../shared/domain/agent-config.ts";
import type { Tool as RemoteMcpTool } from "@modelcontextprotocol/client";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import type { SandboxPermissionMode } from "../../shared/domain/sandbox-config.ts";
import { workspaceMemoryHarnessEnabled } from "../../shared/domain/workspace-config.ts";
import { logWarn } from "../../shared/log.ts";
import { publicConversationKeyFromScoped } from "../../shared/runtime-keys.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import { getStorage } from "../../shared/storage.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type { AsyncToolNames, RunAsyncToolDispatch } from "../async-tools.ts";
import type { RunSessionMessageDispatch } from "../ingress.ts";
import type { DispatchAppliedIngress } from "../integrations.ts";
import type {
  SandboxCpuSample,
  SandboxExecutorConfig,
} from "../sandbox/types.ts";
import type { Session } from "../session.ts";
import {
  listMcpTools,
  mcpConnection,
  type McpConnection,
} from "../mcp/client.ts";
import { mcpTools } from "../mcp/mcp.tool.ts";
import asyncStatusTool from "./async-status.tool.ts";
import bashTool from "./bash.tool.ts";
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
  sandboxSupportsBackgroundJobs,
  sandboxSupportsJobControls,
} from "./filesystem-utils.ts";
import globTool from "./glob.tool.ts";
import getSubagentStatusTool from "./get-subagent-status.tool.ts";
import grepTool from "./grep.tool.ts";
import loadSkillTool from "./load-skill.tool.ts";
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
  dispatchAppliedIngress?: DispatchAppliedIngress;
  dispatchAsyncTools?: RunAsyncToolDispatch;
  dispatchSessionMessage?: RunSessionMessageDispatch;
  // Reports each sandbox exec's CPU so the harness attributes usage per sandbox
  // (agent bash/fs => role "agent"; hosted MCP servers => role "tool").
  onSandboxCpu?: (sample: SandboxCpuSample) => void;
  sandboxMetadata?: SandboxRunMetadata;
  approvalRequirements?: Map<string, true>;
  /** Model-facing tool name → MCP server row id, for per-server policy rules. */
  policyMcpIdsByName?: Map<string, string>;
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
  // Persistence keys on the workspace namespace, or without one on the key
  // resolveAgentRuntime derives per agent; no agent identity leaves runs ephemeral.
  const runsWithoutNamespace =
    workspaces.length === 0 || hasStandaloneSandbox(workspaces, agentSandbox);
  if (
    agentSandbox?.persistent === true &&
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
      readTool({ workspaces: workspaces, agentConfig: agentConfig }),
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
  const asyncToolNames: AsyncToolNames = new Set();

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
      // Every channel can post text, so the progress note is the one channel
      // tool that is always registered.
      sendUpdateTool(context.channel),
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
          agentConfig: agentConfig,
          dispatchAppliedIngress: context.dispatchAppliedIngress,
          eventId: context.session.eventId,
          session: context.session,
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

  // Provider-defined tools: every config.tools key names a tool the configured
  // provider executes itself, resolved off its `tools` namespace.
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

  await registerMcpTools(tools, agentConfig, context);

  // Auto-add the background-job status tool when the agent has any async tool or
  // a reserved sandbox that can launch background jobs.
  if (asyncToolNames.size > 0 || hasBackgroundWorkspace) {
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

  // Withhold last, so a channel's deny list covers sandbox and MCP tools too
  // — those are derived from workspaces and server rows, never from config.tools.
  withholdTools(tools, agentConfig.denyTools);

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncToolNames)
    : tools;
}

function withholdTools(tools: ToolSet, denyTools: string[] | undefined): void {
  for (const toolName of denyTools ?? []) {
    if (toolName in tools) {
      delete tools[toolName];
    }
  }
}

/** One resolved server: its row, connection, and the filtered remote tools. */
interface ResolvedMcpServer {
  serverId: string;
  serverConfig: AgentMcpEntry;
  record: McpRecord;
  connection: McpConnection;
  remoteTools: RemoteMcpTool[];
}

/**
 * Register every enabled connected MCP server's tools (#331). Listings come
 * from the per-server TTL cache in mcp/client.ts, so steady-state runs skip
 * the discovery round-trip.
 */
async function registerMcpTools(
  tools: ToolSet,
  agentConfig: AgentConfig,
  context: Omit<ToolContext, "config">,
): Promise<void> {
  const entries = Object.entries(agentConfig.mcp ?? {}).filter(
    ([, serverConfig]) => serverConfig.enabled !== false,
  );
  if (entries.length === 0) return;
  const accountId = context.accountId;
  if (!accountId) {
    throw new Error(
      `config.mcp.${entries[0]![0]} requires an account-scoped session`,
    );
  }

  // Resolve rows and listings in parallel; the merge below stays sequential
  // in config order so name-conflict detection is deterministic.
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
        const connection = mcpConnection(record, serverConfig.headers);
        // An unreachable server degrades to zero tools for this run instead
        // of killing every agent run that references it; config errors above
        // (unknown id, unresolved header) still throw.
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
    );
    // Sanitized names collapsing within one server surface here too: the map
    // then has fewer keys than the listing had tools.
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

function isToolEnabled(
  config: AgentToolConfig | undefined,
): config is AgentToolConfig {
  return config !== undefined && config.enabled !== false;
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
