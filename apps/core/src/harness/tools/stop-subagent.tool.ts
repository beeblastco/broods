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
  type SubagentToolContext,
  type SubagentToolInput,
} from "./utils.ts";

export default function stopSubagentTool(
  context: SubagentToolContext,
): ToolSet {
  return {
    stop_subagent: tool({
      description:
        "Cooperatively stop a running persistent subagent previously started by this run at its next model boundary. Completed results are injected automatically, so a late stop returns not_running. Use the taskId and agentId returned by run_subagent.",
      inputSchema: jsonSchema<SubagentToolInput>({
        type: "object",
        properties: SUBAGENT_TOOL_PROPERTIES,
        required: ["taskId", "agentId"],
        additionalProperties: false,
      }),
      execute: async function (input) {
        const record = await getOwnedSubagent(context, input);
        if (!record) {
          return toolError(subagentNotFound(input.taskId));
        }

        const stopped = await runtime.mutate<{
          stopped: boolean;
          queuedCount: number;
        }>("stopIngressOwner", {
          accountId: context.accountId,
          agentId: input.agentId,
          conversationKey: record.conversationKey,
        });

        return {
          status: stopped.stopped ? "stopping" : "not_running",
        };
      },
    }),
  };
}
