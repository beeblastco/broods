/**
 * Tavily-backed web research tools for the harness agent.
 * Keep external search and page extraction access here.
 */

import { tavilyExtract, tavilySearch } from "@tavily/ai-sdk";
import type { ToolSet } from "ai";
import type { ToolContext } from "./index.ts";

export function tavilySearchTool(context: ToolContext): ToolSet {
  const { enabled: _enabled, apiKey, ...config } = context.config;
  const tavilyApiKey = typeof apiKey === "string" ? apiKey : undefined;

  if (!tavilyApiKey) {
    throw new Error("config.tools.tavilySearch.apiKey is required.");
  }

  return {
    tavilySearch: tavilySearch({
      apiKey: tavilyApiKey,
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 5,
      topic: "general",
      ...config,
    }),
  };
}

export function tavilyExtractTool(context: ToolContext): ToolSet {
  const { enabled: _enabled, apiKey, ...config } = context.config;
  const tavilyApiKey = typeof apiKey === "string" ? apiKey : undefined;

  if (!tavilyApiKey) {
    throw new Error("config.tools.tavilyExtract.apiKey is required.");
  }

  return {
    tavilyExtract: tavilyExtract({
      apiKey: tavilyApiKey,
      extractDepth: "advanced",
      format: "markdown",
      ...config,
    }),
  };
}
