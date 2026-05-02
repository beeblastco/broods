/**
 * Google provider search tool for the harness agent.
 * Keep Gemini provider-defined search configuration here.
 */

import type { ToolSet } from "ai";
import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";
import type { ToolContext } from "./index.ts";

export default function googleSearchTool(context: ToolContext): ToolSet {
  if (context.modelProviderName !== "google") {
    throw new Error("config.tools.googleSearch requires config.model.provider to be google. Only work with Gemmini 3 model or so");
  }

  const { enabled: _enabled, ...googleSearchConfig } = context.config;
  const google = context.modelProvider as GoogleGenerativeAIProvider;

  return {
    googleSearch: google.tools.googleSearch(googleSearchConfig),
  };
}
