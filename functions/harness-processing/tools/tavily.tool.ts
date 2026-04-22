/**
 * Tavily-backed web research tools for the harness agent.
 * Keep external search and page extraction access here.
 */

import { tavilyExtract, tavilySearch } from "@tavily/ai-sdk";
import type { ToolSet } from "ai";
import { requireEnv } from "../../_shared/env.ts";
import type { ToolContext } from "./index.ts";

const TAVILY_API_KEY = requireEnv("TAVILY_API_KEY");

export default function tavilyTool(_context: ToolContext): ToolSet {
  return {
    tavilySearch: tavilySearch({
      apiKey: TAVILY_API_KEY,
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 5,
      topic: "general",
    }),
    tavilyExtract: tavilyExtract({
      apiKey: TAVILY_API_KEY,
      extractDepth: "advanced",
      format: "markdown",
    }),
  };
}
