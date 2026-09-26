/**
 * Model-facing status lookup for a persistent subagent run.
 * Keep shared parent authorization and types in utils.ts.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { AsyncAgentResultRecord } from "../async-agent-result.ts";
import {
  getOwnedSubagent,
  SUBAGENT_TOOL_PROPERTIES,
  subagentNotFound,
  toolError,
  type SubagentToolContext,
  type SubagentToolInput,
  type SubagentWatch,
} from "./utils.ts";

// How long a check on a running subagent waits for it to finish.
const STATUS_WAIT_MS = 60_000;

type SubagentStatusOutput = Pick<
  AsyncAgentResultRecord,
  "status" | "response" | "error"
>;

export default function getSubagentStatusTool(
  context: SubagentToolContext & { watch?: SubagentWatch },
): ToolSet {
  return {
    get_subagent_status: tool({
      description:
        "Check a persistent subagent previously started by this run, using the taskId and agentId from run_subagent. A running subagent is waited on for up to 60 seconds first. You rarely need this: results are added to this conversation when the subagent finishes, so you can simply end your turn.",
      inputSchema: jsonSchema<SubagentToolInput>({
        type: "object",
        properties: SUBAGENT_TOOL_PROPERTIES,
        required: ["taskId", "agentId"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<SubagentStatusOutput> {
        let record = await getOwnedSubagent(context, input);
        if (!record) {
          return toolError(subagentNotFound(input.taskId));
        }
        if (record.status === "processing" && context.watch) {
          await context.watch.waitForSettled(input.taskId, STATUS_WAIT_MS);
          record = (await getOwnedSubagent(context, input)) ?? record;
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
