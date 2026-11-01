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

const STOPPING_NOTE =
  "It stops at its next model step and sends no report, so do not promise one. Only a final answer it was already writing can still arrive.";

export default function stopSubagentTool(
  context: SubagentToolContext,
): ToolSet {
  return {
    stop_subagent: tool({
      description:
        "Stop a running persistent subagent started earlier in this conversation, at its next model step. A stopped subagent sends no report and its partial work is dropped, so do not promise the user a result. Completed results are injected automatically, so a late stop returns not_running. Use the taskId and agentId returned by run_subagent.",
      inputSchema: jsonSchema<SubagentToolInput>({
        type: "object",
        properties: SUBAGENT_TOOL_PROPERTIES,
        required: ["taskId", "agentId"],
        additionalProperties: false,
      }),
      execute: async function (
        input,
      ): Promise<
        { status: "stopping"; note: string } | { status: "not_running" }
      > {
        const record = await getOwnedSubagent(context, input);
        if (!record) {
          return toolError(subagentNotFound(input.taskId));
        }

        const stopped = await runtime.mutate("stopIngressOwner", {
          accountId: context.accountId,
          agentId: input.agentId,
          conversationKey: record.conversationKey,
          expectedOwnerTaskId: input.taskId,
        });

        if (!stopped.stopped) {
          return { status: "not_running" };
        }

        return {
          status: "stopping",
          note:
            stopped.queuedCount > 0
              ? `${STOPPING_NOTE} The ${stopped.queuedCount} follow-up turn(s) queued on it still run and report.`
              : STOPPING_NOTE,
        };
      },
    }),
  };
}
