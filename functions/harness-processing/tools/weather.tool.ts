// Example inline AI SDK tool showing the expected file shape for adding a new custom tool.
import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolContext } from "./index.ts";

const weatherInputSchema = {
  type: "object",
  properties: {
    city: {
      type: "string",
      description: "The city to get weather for",
    },
  },
  required: ["city"],
  additionalProperties: false,
} as const;

export default function weatherTool(_context: ToolContext): ToolSet {
  return {
    weather: tool({
      description: "Get the weather for a city",
      inputSchema: jsonSchema(weatherInputSchema),
      async execute(input) {
        return `Weather for ${String(input.city)}: sunny`;
      },
    }),
  };
}
