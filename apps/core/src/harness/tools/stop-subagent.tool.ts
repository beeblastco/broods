/**
 * Model-facing cooperative stop for a persistent subagent run.
 * Keep shared parent authorization and types in utils.ts.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { runtime } from "../../shared/convex/runtime.ts";
import {
  getOwnedSubagent,
  SUBAGENT_TOOL_PROPERTIES,
  subagentNotFound,
  toolError,
  toolText,
  toToolResultOutput,
  type SubagentToolContext,
  type SubagentToolInput,
} from "./utils.ts";

export default function stopSubagentTool(context: SubagentToolContext) {
  return {
    stop_subagent: tool({
      description:
        "Cooperatively stop a running persistent subagent previously started by this run at its next model boundary. Use the taskId and agentId returned by run_subagent.",
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
        if (record.status !== "processing") {
          return toolError(`Error: subagent is already ${record.status}`);
        }

        const stopped = await runtime.mutate<{
          stopped: boolean;
          queuedCount: number;
        }>("stopIngressOwner", {
          accountId: context.accountId,
          agentId: input.agentId,
          conversationKey: record.conversationKey,
        });

        return toolText(
          stopped.stopped
            ? "stopping at the next model boundary"
            : "not running",
        );
      },
    }),
  } satisfies ToolSet;
}
