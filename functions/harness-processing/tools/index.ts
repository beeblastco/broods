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
import filesystemTool from "./filesystem.tool.ts";
import googleSearchTool from "./google-search.tool.ts";
import tasksTool from "./tasks.tool.ts";
import { tavilyExtractTool, tavilySearchTool } from "./tavily.tool.ts";

export interface ToolContext {
  conversationKey: string;
  filesystemNamespace: string;
  config: AccountToolConfig;
  modelProviderName: AccountModelProviderName;
  modelProvider: unknown;
}

type ToolFactory = (context: ToolContext) => ToolSet;
const toolFactories = {
  tavilySearch: tavilySearchTool,
  tavilyExtract: tavilyExtractTool,
  googleSearch: googleSearchTool,
} satisfies Record<string, ToolFactory>;

export function createTools(context: Omit<ToolContext, "config">, accountConfig: AccountConfig): ToolSet {
  const tools: ToolSet = {};
  assertSupportedConfiguredTools(accountConfig.tools);

  if (accountConfig.workspace?.enabled === true) {
    Object.assign(
      tools,
      filesystemTool({ ...context, config: {} }),
      tasksTool({ ...context, config: {} }),
    );
  }

  for (const [toolName, toolFactory] of Object.entries(toolFactories)) {
    const toolConfig = accountConfig.tools?.[toolName];
    if (!isToolEnabled(toolConfig)) {
      continue;
    }

    Object.assign(tools, toolFactory({
      ...context,
      config: toolConfig,
    }));
  }

  return tools;
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
