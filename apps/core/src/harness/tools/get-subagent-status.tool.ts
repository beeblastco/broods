/**
 * Model-facing status lookup for a persistent subagent run.
 * Keep shared parent authorization and types in utils.ts.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import {
  getAsyncAgentResult,
  markAsyncAgentHandback,
  type AsyncAgentResultRecord,
} from "../async-agent-result.ts";
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

interface GetSubagentStatusContext extends SubagentToolContext {
  watch?: SubagentWatch;
}

// `delivery: "automatic"` stands in for the result when a resume of it already
// waits in the queue and tells the conversation next.
type SubagentStatusOutput = Pick<
  AsyncAgentResultRecord,
  "status" | "response" | "error"
> & { delivery?: "automatic" };

export default function getSubagentStatusTool(
  context: GetSubagentStatusContext,
): ToolSet {
  return {
    get_subagent_status: tool({
      description:
        'Check a persistent subagent started earlier in this conversation, using the taskId and agentId from run_subagent. A running subagent this turn started is waited on for up to 60 seconds first. You rarely need this: its result arrives in this conversation as a new message when it finishes, even after your turn ends, so you can simply end your turn. A result already on its way answers delivery "automatic" instead of a response: it arrives as the next message.',
      inputSchema: jsonSchema<SubagentToolInput>({
        type: "object",
        properties: SUBAGENT_TOOL_PROPERTIES,
        required: ["taskId", "agentId"],
        additionalProperties: false,
      }),
      execute: async function (
        input,
        { abortSignal },
      ): Promise<SubagentStatusOutput> {
        let record = await getOwnedSubagent(context, input);
        if (!record) {
          return toolError(subagentNotFound(input.taskId));
        }
        if (record.status === "processing" && context.watch) {
          await context.watch.waitForSettled(
            input.taskId,
            STATUS_WAIT_MS,
            abortSignal,
          );
          // Ownership is settled; only the row can have changed.
          record = (await getAsyncAgentResult(record.eventId)) ?? record;
        }
        // The model now holds the outcome, so it is not injected a second time:
        // by this turn once the step saves, by a late resume or the recovery
        // sweep from now on. A pending row is this run's to store: the
        // coordinator marks it once the step that carries this read is saved
        // (`confirmDelivered`), so a pod that dies in between leaves it to the
        // sweep. A detached row is the sweep's already, so the read marks it
        // now, as does a read with no coordinator to confirm it later. A
        // resume of it already queued keeps it: that resume tells it next, so
        // this read hands nothing over.
        if (record.status === "completed" || record.status === "failed") {
          if (
            (record.handback === "detached" ||
              (record.handback === "pending" && !context.watch)) &&
            (await markAsyncAgentHandback(record.eventId, "stored"))
          ) {
            return { status: record.status, delivery: "automatic" };
          }
          context.watch?.markDelivered(record.eventId);
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
