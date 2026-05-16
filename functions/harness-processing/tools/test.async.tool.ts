/**
 * Test async tool fixture.
 * Keep local async-tool example behavior separate from production integrations.
 */

import { jsonSchema, tool, type ToolSet } from "ai";

export default function testAsyncTool(): ToolSet {
  return {
    test_async: tool({
      description: "Test async tool.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return {
          type: "text",
          value: "test_async completed successfully",
        };
      },
    }),
  };
}
