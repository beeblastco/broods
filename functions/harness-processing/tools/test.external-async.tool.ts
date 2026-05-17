/**
 * Test external async tool that calls a mock external Lambda Function URL.
 * Dispatches work to the external service and returns immediately;
 * the external service calls back to completePath to settle the result.
 */

import { jsonSchema, tool, type ToolSet } from "ai";

interface AsyncToolOptions {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  completePath: string;
  statusReference: { table: string; resultId: string };
}

export default function testExternalAsyncTool(): ToolSet {
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

        await fetch(toolUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: input.message, completeUrl: `${toolUrl.replace(/\/$/, "")}${asyncTool.completePath}` }),
        });

        return { type: "text", value: "Dispatched. Waiting for result..." };
      },
    }),
  };
}
