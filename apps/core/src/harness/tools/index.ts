/**
 * Harness tool registry.
 * Keep static tool imports and agent-configured tool selection here.
 *
 * Sandbox tools (bash/read/write/edit/glob/grep) are enabled by the presence of
 * a referenced sandbox + workspaces. Approval is produced as AI SDK v7
 * toolApproval in the harness.
 * config.tools-driven tools (search/research/handoffs) remain opt-in.
 */

import type { ToolSet } from "ai";
import {
  type AgentConfig,
  type AccountModelProviderName,
  type AgentToolConfig,
  type SandboxPermissionMode,
  getStorage,
} from "../../shared/storage/index.ts";
import { logWarn } from "../../shared/log.ts";
import type { Session } from "../session.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type { SandboxCpuSample, SandboxExecutorConfig } from "../sandbox/types.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import type { AsyncToolModeMap, AsyncToolSource, RunAsyncToolDispatch } from "../async-tools.ts";
import bashTool from "./bash.tool.ts";
import readTool from "./read.tool.ts";
import writeTool from "./write.tool.ts";
import editTool from "./edit.tool.ts";
import globTool from "./glob.tool.ts";
import grepTool from "./grep.tool.ts";
import googleSearchTool from "./google-search.tool.ts";
import handoffsTool from "./handoffs.tool.ts";
import loadSkillTool from "./load-skill.tool.ts";
import runSubagentTool, {
  type RunSubagentDispatch,
} from "./run-subagent.tool.ts";
import { tavilyExtractTool, tavilySearchTool } from "./tavily.tool.ts";
import asyncStatusTool from "./async-status.tool.ts";
import accountTool from "./account-tool.tool.ts";
import { prewarmAccountTool } from "./custom-tool-executor.ts";
import { sandboxSupportsBackgroundJobs, sandboxSupportsJobControls } from "./filesystem-utils.ts";
import { isAccountToolId } from "../../shared/storage/account-tools.ts";

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

type ToolFactory = (context: ToolContext) => ToolSet;

// config.tools-driven tools. Sandbox and subagent tools are registered below
// because their enablement is controlled outside config.tools.
const toolFactories = {
  tavilySearch: tavilySearchTool,
  tavilyExtract: tavilyExtractTool,
  googleSearch: googleSearchTool,
} satisfies Record<string, ToolFactory>;

export async function createTools(context: Omit<ToolContext, "config">, agentConfig: AgentConfig): Promise<ToolSet> {
  const tools: ToolSet = {};
  assertSupportedConfiguredTools(agentConfig.tools);

  // Sandbox tool surface. Tool availability is derived per workspace:
  //  - bash: stateless (no workspace) on the agent-level sandbox, or in any
  //    sandbox-backed workspace.
  //  - read/glob: every workspace (sandbox-backed via the mount, read-only
  //    workspaces straight from S3).
  //  - write/edit/grep: sandbox-backed workspaces only.
  // Per-call sandbox approval is handled by the harness-level v7 toolApproval.
  const workspaces = context.workspaces ?? [];
  const sandboxWorkspaces = workspaces.filter((workspace) => workspace.sandbox);
  const statelessSandbox = workspaces.length === 0 ? context.statelessSandbox : undefined;
  const statelessOptions = typeof statelessSandbox?.options === "object" && statelessSandbox.options !== null
    ? statelessSandbox.options as Record<string, unknown>
    : {};
  const hasStatelessReservation = typeof statelessOptions.reservationKey === "string" && statelessOptions.reservationKey.trim().length > 0;
  if (statelessSandbox?.persistent === true && !hasStatelessReservation) {
    // Persistence is keyed by workspace namespace; a stateless (no-workspace)
    // sandbox needs an explicit options.reservationKey to reconnect — warn so a
    // misconfiguration is visible rather than silently behaving ephemerally.
    logWarn("persistent sandbox attached without a workspace; it runs ephemerally", {
      conversationKey: context.conversationKey,
    });
  }
  const sandboxTools: ToolSet = {};
  
  // Reserved (persistent) workspaces can run detached background jobs; bash then
  // exposes a `background` flag and records each job under the parent session.
  const hasBackgroundWorkspace = workspaces.some((workspace) => sandboxSupportsBackgroundJobs(workspace.sandbox));
  // eventId identifies the turn that spawned the job (stored as parentEventId on the
  // async-tool-result record); conversationKey identifies which conversation to resume
  // when the job completes in a future continuation worker. delivery carries the
  // originating channel/WebSocket so the result is pushed back there, not just polled.
  const backgroundContext = hasBackgroundWorkspace && context.session
    ? {
      eventId: context.session.eventId,
      conversationKey: context.conversationKey,
      ...(context.session.delivery ? { delivery: context.session.delivery } : {}),
    }
    : undefined;

  // bash: stateless (no workspace) on the agent sandbox, or in any sandbox-backed workspace.
  // Pass the full workspace list so omitting `workspace` preserves the configured
  // default; if that default is read-only, the tool returns a clear error instead
  // of silently selecting the first writable workspace.
  if (statelessSandbox || sandboxWorkspaces.length > 0) {
    Object.assign(sandboxTools,
      bashTool({
        workspaces,
        ...(statelessSandbox
          ? { statelessSandbox, statelessPermissionMode: context.statelessPermissionMode ?? "ask" }
          : {}),
        ...(backgroundContext ? { background: backgroundContext } : {}),
        ...(context.onSandboxCpu ? { onSandboxCpu: context.onSandboxCpu } : {}),
      }
    ));
  }
  // read/glob: every workspace (sandbox-backed via the mount, read-only via S3).
  if (workspaces.length > 0) {
    Object.assign(
      sandboxTools,
      readTool({ workspaces }),
      globTool({ workspaces })
    );
  }
  // write/edit/grep: require a sandbox at execution time. Pass the full workspace
  // list to preserve default-workspace semantics; read-only selections fail clearly.
  if (sandboxWorkspaces.length > 0) {
    const fsContext = { workspaces, ...(context.onSandboxCpu ? { onSandboxCpu: context.onSandboxCpu } : {}) };
    Object.assign(
      sandboxTools,
      writeTool(fsContext),
      editTool(fsContext),
      grepTool(fsContext),
    );
  }
  Object.assign(tools, sandboxTools);
  const asyncModes: AsyncToolModeMap = new Map();

  // Subagent execution is orchestrated by the handler/coordinator. The registry
  // exposes only the model-facing tool when config and runtime dispatcher agree.
  if (agentConfig.subagent?.enabled === true && context.dispatchSubagents) {
    Object.assign(tools, runSubagentTool({
      dispatchSubagents: context.dispatchSubagents,
      mode: agentConfig.subagent.mode,
    }));
  }

  const allowedSkillPaths = agentConfig.skills?.allowed ?? [];
  if (agentConfig.skills?.enabled === true && allowedSkillPaths.length > 0 && context.session) {
    Object.assign(tools, loadSkillTool(
      context.session,
      (skillPath, resourcePaths) => context.session!.loadSkillPrompt(allowedSkillPaths, skillPath, resourcePaths),
    ));
  }

  for (const [toolName, toolFactory] of Object.entries(toolFactories)) {
    const toolConfig = agentConfig.tools?.[toolName];
    if (!isToolEnabled(toolConfig)) {
      continue;
    }

    if (toolConfig.needsApproval === true) context.approvalRequirements?.set(toolName, true);
    Object.assign(tools, toolFactory({
      ...context,
      config: externalToolRuntimeConfig(toolConfig),
    }));
    addAsyncModeIfConfigured(asyncModes, toolName, toolConfig, "built-in");
  }

  const handoffsConfig = agentConfig.tools?.handoffs;
  if (isToolEnabled(handoffsConfig)) {
    if (handoffsConfig.needsApproval === true) context.approvalRequirements?.set("handoffs", true);
    Object.assign(tools, handoffsTool({
      ...context,
      channels: agentConfig.channels,
      config: externalToolRuntimeConfig(handoffsConfig),
    }));
    addAsyncModeIfConfigured(asyncModes, "handoffs", handoffsConfig, "built-in");
  }

  for (const [toolId, toolConfig] of Object.entries(agentConfig.tools ?? {}).filter(([key]) => isAccountToolId(key))) {
    if (!isToolEnabled(toolConfig)) {
      continue;
    }
    if (!context.accountId) {
      throw new Error(`config.tools.${toolId} requires an account-scoped session`);
    }
    const accountId = context.accountId;
    const record = await getStorage().accountTools.getById(accountId, toolId);
    if (!record || record.status !== "active") {
      throw new Error(`config.tools.${toolId} references an unknown account tool`);
    }
    if (tools[record.name]) {
      throw new Error(`config.tools.${toolId} model-facing name '${record.name}' conflicts with another tool`);
    }
    if (toolConfig.needsApproval === true) context.approvalRequirements?.set(record.name, true);
    context.policyToolIdsByName?.set(record.name, toolId);
    Object.assign(tools, accountTool(record, {
      ...context,
      accountId,
      config: externalToolRuntimeConfig(toolConfig),
    }));
    addAsyncModeIfConfigured(asyncModes, record.name, toolConfig, "uploaded");
    // Warm the tool's sandbox pod now, in parallel with the model's first
    // response, so an async call lands on a ready pod instead of cold-starting.
    if (toolConfig.async === true) {
      prewarmAccountTool(accountId, toolId);
    }
  }

  // Auto-add the background-job status tool when the agent has any async tool or
  // a reserved sandbox that can launch background jobs.
  if (asyncModes.size > 0 || hasBackgroundWorkspace) {
    Object.assign(tools, asyncStatusTool({
      conversationKey: context.conversationKey,
      workspaces,
      // logs/stop only apply when the background provider exposes live controls.
      supportsJobs: workspaces.some((workspace) => sandboxSupportsJobControls(workspace.sandbox)),
    }));
  }

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncModes)
    : tools;
}

function assertSupportedConfiguredTools(tools: AgentConfig["tools"]): void {
  for (const toolName of Object.keys(tools ?? {})) {
    if (!(toolName in toolFactories) && toolName !== "handoffs" && !isAccountToolId(toolName)) {
      throw new Error(`config.tools.${toolName} is not a supported tool`);
    }
  }
}

function isToolEnabled(config: AgentToolConfig | undefined): config is AgentToolConfig {
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
