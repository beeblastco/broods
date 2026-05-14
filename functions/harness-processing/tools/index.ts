/**
 * Harness tool registry.
 * Keep static tool imports and account-configured tool selection here.
 */

import type { ToolSet } from "ai";
import {
  type AccountConfig,
  type AccountModelProviderName,
  type AccountToolConfig,
} from "../../_shared/accounts.ts";
import type { Session } from "../session.ts";
import filesystemTool from "./filesystem.tool.ts";
import googleSearchTool from "./google-search.tool.ts";
import loadSkillTool from "./load-skill.tool.ts";
import runSubagentTool, {
  type RunSubagentDispatch,
} from "./run-subagent.tool.ts";
import tasksTool from "./tasks.tool.ts";
import { tavilyExtractTool, tavilySearchTool } from "./tavily.tool.ts";

// Runtime dependencies shared by tool factories. Model-facing input schemas
// stay inside each individual tool file.
export interface ToolContext {
  conversationKey: string;
  filesystemNamespace: string;
  config: AccountToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
  session?: Session;
  dispatchSubagents?: RunSubagentDispatch;
}

type ToolFactory = (context: ToolContext) => ToolSet;

// Account-configured tools. Workspace and subagent tools are registered below
// because their enablement is controlled outside config.tools.
const toolFactories = {
  tavilySearch: tavilySearchTool,
  tavilyExtract: tavilyExtractTool,
  googleSearch: googleSearchTool,
} satisfies Record<string, ToolFactory>;

export function createTools(context: Omit<ToolContext, "config">, accountConfig: AccountConfig): ToolSet {
  const tools: ToolSet = {};
  assertSupportedConfiguredTools(accountConfig.tools);

  if (accountConfig.workspace?.enabled === true) {
    const needsApproval = accountConfig.workspace.needsApproval === true;
    Object.assign(
      tools,
      ...(accountConfig.workspace.filesystem?.enabled === false ? [] : [
        withToolApproval(filesystemTool({ ...context, config: {} }), {
          filesystem: needsApproval,
        }),
      ]),
      ...(accountConfig.workspace.tasks?.enabled === false ? [] : [
        withToolApproval(tasksTool({ ...context, config: {} }), {
          tasks: needsApproval,
        }),
      ]),
    );
  }

  // Subagent execution is orchestrated by the handler/coordinator. The registry
  // exposes only the model-facing tool when config and runtime dispatcher agree.
  if (accountConfig.subagent?.enabled === true && context.dispatchSubagents) {
    Object.assign(tools, runSubagentTool({
      dispatchSubagents: context.dispatchSubagents,
    }));
  }

  const allowedSkillPaths = accountConfig.skills?.allowed ?? [];
  if (accountConfig.skills?.enabled === true && allowedSkillPaths.length > 0 && context.session) {
    Object.assign(tools, loadSkillTool(
      context.session,
      (skillPath, resourcePaths) => context.session!.loadSkillPrompt(allowedSkillPaths, skillPath, resourcePaths),
    ));
  }

  for (const [toolName, toolFactory] of Object.entries(toolFactories)) {
    const toolConfig = accountConfig.tools?.[toolName];
    if (!isToolEnabled(toolConfig)) {
      continue;
    }

    Object.assign(tools, withToolApproval(toolFactory({
      ...context,
      config: toolConfig,
    }), {
      [toolName]: toolConfig.needsApproval === true,
    }));
  }

  return tools;
}

function withToolApproval(tools: ToolSet, approvals: Record<string, boolean>): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, entry]) => [
      toolName,
      approvals[toolName] === true ? { ...entry, needsApproval: true } : entry,
    ]),
  ) satisfies ToolSet;
}

function assertSupportedConfiguredTools(tools: AccountConfig["tools"]): void {
  for (const toolName of Object.keys(tools ?? {})) {
    if (!(toolName in toolFactories)) {
      throw new Error(`config.tools.${toolName} is not a supported tool`);
    }
  }
}

function isToolEnabled(config: AccountToolConfig | undefined): config is AccountToolConfig {
  return config !== undefined && config.enabled !== false;
}
