/**
 * Harness tool registry, check for tool mode.
 * Keep static tool imports and agent-configured tool selection here.
 */

import type { ToolSet } from "ai";
import {
  type AgentConfig,
  type AgentChannelsConfig,
  type AccountModelProviderName,
  type AgentToolConfig,
} from "../../_shared/storage/index.ts";
import type { Session } from "../session.ts";
import type { AsyncToolModeMap, RunAsyncToolDispatch } from "../async-tools.ts";
import filesystemTool from "./filesystem.tool.ts";
import googleSearchTool from "./google-search.tool.ts";
import loadSkillTool from "./load-skill.tool.ts";
import pancakeToggleTagTool from "./pancake-toggle-tag.tool.ts";
import runSubagentTool, {
  type RunSubagentDispatch,
} from "./run-subagent.tool.ts";
import tasksTool from "./tasks.tool.ts";
import { tavilyExtractTool, tavilySearchTool } from "./tavily.tool.ts";
import testAsyncTool from "./test.async.tool.ts";
import testExternalAsyncTool from "./test.external-async.tool.ts";

// Runtime dependencies shared by tool factories. Model-facing input schemas
// stay inside each individual tool file.
export interface ToolContext {
  conversationKey: string;
  filesystemNamespace: string;
  channels?: AgentChannelsConfig;
  config: AgentToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
  session?: Session;
  dispatchSubagents?: RunSubagentDispatch;
  dispatchAsyncTools?: RunAsyncToolDispatch;
}

type ToolFactory = (context: ToolContext) => ToolSet;

// Agent-configured tools. Workspace and subagent tools are registered below
// because their enablement is controlled outside config.tools.
const toolFactories = {
  tavilySearch: tavilySearchTool,
  tavilyExtract: tavilyExtractTool,
  googleSearch: googleSearchTool,
  pancake_toggle_tag: pancakeToggleTagTool,
  test_async: testAsyncTool,
  test_external_async: testExternalAsyncTool,
} satisfies Record<string, ToolFactory>;

export function createTools(context: Omit<ToolContext, "channels" | "config">, agentConfig: AgentConfig): ToolSet {
  const tools: ToolSet = {};
  assertSupportedConfiguredTools(agentConfig.tools);
  const baseContext = { ...context, channels: agentConfig.channels };

  if (agentConfig.workspace?.enabled === true) {
    const needsApproval = agentConfig.workspace.needsApproval === true;
    Object.assign(
      tools,
      ...(agentConfig.workspace.filesystem?.enabled === false ? [] : [
        // Passing the sandbox configure into the filesystem tool.
        withToolApproval(filesystemTool({
          ...baseContext,
          config: agentConfig.workspace.sandbox ?? {},
        }), {
          filesystem: needsApproval,
        }),
      ]),
      ...(agentConfig.workspace.tasks?.enabled === false ? [] : [
        withToolApproval(tasksTool({ ...baseContext, config: {} }), {
          tasks: needsApproval,
        }),
      ]),
    );
  }

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
      ...baseContext,
      config: externalToolRuntimeConfig(toolConfig),
    }), {
      [toolName]: toolConfig.needsApproval === true,
    }));
  }

  return context.dispatchAsyncTools
    ? context.dispatchAsyncTools(tools, asyncConfiguredToolModes(agentConfig.tools))
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
    if (!(toolName in toolFactories)) {
      throw new Error(`config.tools.${toolName} is not a supported tool`);
    }
  }
}

function isToolEnabled(config: AgentToolConfig | undefined): config is AgentToolConfig {
  return config !== undefined && config.enabled !== false;
}

function asyncConfiguredToolModes(tools: AgentConfig["tools"]): AsyncToolModeMap {
  return new Map(
    Object.entries(tools ?? {})
      .filter(([, config]) => isToolEnabled(config) && config.async === true)
      .map(([toolName, config]) => [toolName, config.execution ?? "same-invocation"]),
  );
}

function externalToolRuntimeConfig(config: AgentToolConfig): AgentToolConfig {
  const {
    enabled: _enabled,
    needsApproval: _needsApproval,
    async: _async,
    execution: _execution,
    ...runtimeConfig
  } = config;

  return runtimeConfig;
}
