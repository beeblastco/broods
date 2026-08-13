/**
 * Model-facing status lookup for a persistent subagent run.
 * Keep shared parent authorization and types in utils.ts.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import {
  getOwnedSubagent,
  SUBAGENT_TOOL_PROPERTIES,
  subagentNotFound,
  toolError,
  toToolResultOutput,
  type SubagentToolContext,
  type SubagentToolInput,
} from "./utils.ts";

export default function getSubagentStatusTool(
  context: SubagentToolContext,
): ToolSet {
  return {
    get_subagent_status: tool({
      description:
        "Check the current status of a persistent subagent previously started by this run. Use the taskId and agentId returned by run_subagent.",
      inputSchema: jsonSchema<SubagentToolInput>({
        type: "object",
        properties: SUBAGENT_TOOL_PROPERTIES,
        required: ["taskId", "agentId"],
        additionalProperties: false,
      }),
      toModelOutput: toToolResultOutput,
      execute: async function (input) {
        const record = await getOwnedSubagent(context, input);
        if (!record) {
          return toolError(subagentNotFound(input.taskId));
        }

        return {
          status: record.status,
          ...(record.response !== undefined
            ? { response: record.response }
            : {}),
          ...(record.error !== undefined ? { error: record.error } : {}),
        };
      },
    }),
  };
}
