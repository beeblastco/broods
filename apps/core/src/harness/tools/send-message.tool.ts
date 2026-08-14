/**
 * Inter-session messaging for configured channel conversations.
 * Keep admission and worker scheduling in the handler-owned dispatcher.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type {
  RunSessionMessageDispatch,
  SessionMessageInput,
} from "../ingress.ts";
import { toolText, toToolResultOutput } from "./utils.ts";

const MESSAGE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    conversationKey: {
      type: "string",
      minLength: 1,
      description: "Conversation key of the target agent session.",
    },
    message: {
      type: "string",
      minLength: 1,
      description: "Message to deliver to the target session.",
    },
  },
  required: ["conversationKey", "message"],
  additionalProperties: false,
};

export default function sendMessageTool(
  dispatch: RunSessionMessageDispatch,
): ToolSet {
  return {
    "send-message": tool({
      description:
        "Sends a message to another conversation session. The target agent processes it as a follow-up and replies in that conversation.",
      inputSchema: jsonSchema(MESSAGE_SCHEMA),
      toModelOutput: toToolResultOutput,
      execute: async function (input): Promise<string> {
        const result = await dispatch(input as SessionMessageInput);

        return toolText(
          `Message ${result.status} for conversation ${result.conversationKey}.`,
        );
      },
    }),
  };
}
