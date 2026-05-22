/**
 * Pancake handoff tool for switching the current conversation to human mode.
 * Keep channel-specific reply-mode writes here.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import {
  PANCAKE_NO_CUSTOMER_REPLY,
  resolvePancakeSupabaseOptions,
  setPancakeSupabaseReplyModeToHuman,
} from "../../_shared/pancake-channel.ts";
import type { AgentConfig } from "../../_shared/accounts.ts";
import type { ToolContext } from "./index.ts";

export default function setReplyModeTool(context: ToolContext, agentConfig: AgentConfig): ToolSet {
  return {
    set_reply_mode: tool({
      description:
        `Switch the current Pancake conversation from automatic replies to human handoff. ` +
        `After this tool succeeds, the final response must be exactly ${PANCAKE_NO_CUSTOMER_REPLY} and no other text.`,
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      async execute() {
        const supabase = resolvePancakeSupabaseOptions(agentConfig.channels?.pancake?.options);
        if (!supabase) {
          throw new Error("set_reply_mode requires config.channels.pancake.options.supabase");
        }
        if (!context.conversationKey.includes(":pancake:")) {
          throw new Error("set_reply_mode only supports Pancake conversations");
        }

        const result = await setPancakeSupabaseReplyModeToHuman(supabase, context.conversationKey);
        return {
          type: "text",
          value: [
            result.changed
              ? "reply_mode changed from auto to human."
              : "reply_mode was not changed because the current mode is not auto.",
            `Final response must be exactly ${PANCAKE_NO_CUSTOMER_REPLY} and no other text.`,
          ].join(" "),
        };
      },
    }),
  };
}
