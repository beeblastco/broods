/**
 * Test external async tool that calls a mock external Lambda Function URL.
 * Dispatches work to the external service and returns immediately;
 * the external service calls back to completePath to settle the result.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolContext } from "./index.ts";

interface AsyncToolOptions {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  completePath: string;
  statusReference: { table: string; resultId: string };
}

export default function testExternalAsyncTool(context: Pick<ToolContext, "config">): ToolSet {
  return {
    test_external_async: tool({
      description: "Call an external mock async service that returns a greeting.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          message: { type: "string", description: "Message to send." },
        },
        required: ["message"],
        additionalProperties: false,
      }),
      execute: async (input, options) => {
        const toolUrl = process.env.MOCK_EXTERNAL_ASYNC_TOOL_URL;
        if (!toolUrl) throw new Error("MOCK_EXTERNAL_ASYNC_TOOL_URL is not configured");

        const asyncTool = (options as unknown as { asyncTool?: AsyncToolOptions }).asyncTool;
        if (!asyncTool?.completePath) throw new Error("completePath not available");

        const completionBaseUrl = configString(context.config, "completionBaseUrl");
        const completionBearerToken = configString(context.config, "completionBearerToken");
        if (!completionBaseUrl) throw new Error("config.tools.test_external_async.completionBaseUrl is required");
        if (!completionBearerToken) throw new Error("config.tools.test_external_async.completionBearerToken is required");

        const response = await fetch(toolUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: input.message,
            completeUrl: new URL(asyncTool.completePath, ensureTrailingSlash(completionBaseUrl)).toString(),
            completionHeaders: {
              Authorization: `Bearer ${completionBearerToken}`,
            },
          }),
        });
        if (!response.ok) {
          throw new Error(`External async mock dispatch failed: ${response.status} ${await response.text()}`);
        }

        return { type: "text", value: "Dispatched. The result will be injected back to the conversation when finished" };
      },
    }),
  };
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
