/**
 * Harness tool registry.
 * Keep static tool imports and agent-configured tool selection here.
 *
 * Sandbox tools (bash/read/write/edit/glob/grep) are enabled by the presence of
 * a referenced sandbox + workspaces, gated by the sandbox's permissionMode.
 * config.tools-driven tools (search/research/handoffs) remain opt-in.
 */

import type { ToolSet } from "ai";
import {
  type AgentConfig,
  type AccountModelProviderName,
  type AgentToolConfig,
  type SandboxPermissionMode,
  getStorage,
} from "../../_shared/storage/index.ts";
import { logWarn } from "../../_shared/log.ts";
import type { Session } from "../session.ts";
import type { ResolvedWorkspace } from "../../_shared/workspaces.ts";
import type { SandboxExecutorConfig } from "../sandbox/types.ts";
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
  // Each tool sets its own per-call `needsApproval` from the selected
  // workspace's permissionMode, so workspaces can differ in approval policy.
  const workspaces = context.workspaces ?? [];
  const sandboxWorkspaces = workspaces.filter((workspace) => workspace.sandbox);
  const statelessSandbox = workspaces.length === 0 ? context.statelessSandbox : undefined;
  if (statelessSandbox?.persistent === true) {
    // Persistence is keyed by workspace namespace; a stateless (no-workspace)
    // sandbox cannot reconnect, run background jobs, or keep packages — warn so a
    // misconfiguration is visible rather than silently behaving ephemerally.
    logWarn("persistent sandbox attached without a workspace; it runs ephemerally", {
      conversationKey: context.conversationKey,
    });
  }
  const sandboxTools: ToolSet = {};
  
  // Reserved (persistent) workspaces can run detached background jobs; bash then
  // exposes a `background` flag and records each job under the parent session.
  const hasPersistentWorkspace = workspaces.some((workspace) => workspace.sandbox?.persistent === true);
  // eventId identifies the turn that spawned the job (stored as parentEventId on the
  // async-tool-result record); conversationKey identifies which conversation to resume
  // when the job completes in a future Lambda invocation. delivery carries the
  // originating channel/WebSocket so the result is pushed back there, not just polled.
  const backgroundContext = hasPersistentWorkspace && context.session
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
    Object.assign(
      sandboxTools,
      writeTool({ workspaces }),
      editTool({ workspaces }),
      grepTool({ workspaces }),
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

    Object.assign(tools, withToolApproval(toolFactory({
      ...context,
      config: externalToolRuntimeConfig(toolConfig),
    }), {
      [toolName]: toolConfig.needsApproval === true,
    }));
    addAsyncModeIfConfigured(asyncModes, toolName, toolConfig, "built-in");
  }

  const handoffsConfig = agentConfig.tools?.handoffs;
  if (isToolEnabled(handoffsConfig)) {
    Object.assign(tools, withToolApproval(handoffsTool({
      ...context,
      channels: agentConfig.channels,
      config: externalToolRuntimeConfig(handoffsConfig),
    }), {
      handoffs: handoffsConfig.needsApproval === true,
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
    Object.assign(tools, withToolApproval(accountTool(record, {
      ...context,
      accountId,
      config: externalToolRuntimeConfig(toolConfig),
    }), {
      [record.name]: toolConfig.needsApproval === true,
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
  if (asyncModes.size > 0 || hasPersistentWorkspace) {
    Object.assign(tools, asyncStatusTool({
      conversationKey: context.conversationKey,
      workspaces,
      // logs/stop only apply when a background (bash) job can actually be
      // launched, which is exactly when backgroundContext is wired up.
      supportsJobs: backgroundContext !== undefined,
    }));
  }

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncModes)
    : tools;
}

function withToolApproval(tools: ToolSet, approvals: Record<string, boolean>): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, entry]) => [
      toolName,
      approvals[toolName] === true ? { ...entry, needsApproval: true } : entry,
    ]),
  ) satisfies ToolSet;
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

function isAccountToolId(toolName: string): boolean {
  return /^tool_[A-Za-z0-9_-]+$/.test(toolName);
}
