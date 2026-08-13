/**
 * Model-facing steering and follow-up updates for persistent subagent runs.
 * Keep shared parent authorization and types in utils.ts.
 */

import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { scopedDirectEventId } from "../../shared/runtime-keys.ts";
import { acceptIngress, type IngressMode } from "../ingress.ts";
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

interface UpdateSubagentInput extends SubagentToolInput {
  mode: "steer" | "continue";
  message: string;
}

export default function updateSubagentTool(
  context: SubagentToolContext,
): ToolSet {
  return {
    update_subagent: tool({
      description:
        'Update a running persistent subagent previously started by this run. Use mode "steer" to change its direction at the next model boundary, or "continue" to queue a follow-up turn after its current work.',
      inputSchema: jsonSchema<UpdateSubagentInput>({
        type: "object",
        properties: {
          ...SUBAGENT_TOOL_PROPERTIES,
          mode: {
            type: "string",
            enum: ["steer", "continue"],
          },
          message: {
            type: "string",
            description: "The non-empty steering instruction or follow-up.",
          },
        },
        required: ["taskId", "agentId", "mode", "message"],
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

        const message = input.message.trim();
        if (!message) {
          return toolError("Error: update requires a non-empty message");
        }

        const requestedMode: IngressMode =
          input.mode === "steer" ? "steer" : "followup";
        const controlEventId = scopedDirectEventId(
          context.accountId,
          input.agentId,
          crypto.randomUUID(),
        );
        const events: ModelMessage[] = [{ role: "user", content: message }];
        const admission = await acceptIngress({
          accountId: context.accountId,
          agentId: input.agentId,
          eventId: controlEventId,
          conversationKey: record.conversationKey,
          events: events,
          requestedMode: requestedMode,
          idempotencyKey: controlEventId,
          delivery: {
            kind: "async",
            publicEventId: controlEventId,
            publicConversationKey: record.conversationKey,
            statusUrl: "",
          },
        });
        if (admission.outcome !== "queued") {
          return toolError(
            `Error: subagent could not accept ${input.mode}: ${admission.outcome}`,
          );
        }

        return toolText(
          input.mode === "steer" ? "steering queued" : "follow-up queued",
        );
      },
    }),
  };
}
