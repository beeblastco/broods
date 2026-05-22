/**
 * Pancake handoff tool for switching the current conversation to human mode.
 * Keep channel-specific reply-mode writes here.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import {
  resolvePancakeSupabaseOptions,
  setPancakeSupabaseReplyModeToHuman,
} from "../../_shared/pancake-channel.ts";
import type { AgentConfig } from "../../_shared/accounts.ts";
import type { ToolContext } from "./index.ts";

export default function pancakeHandoffToHumanTool(context: ToolContext, agentConfig: AgentConfig): ToolSet {
  return {
    pancake_handoff_to_human: tool({
      description:
        "Switch the current Pancake conversation from automatic replies to human handoff. " +
        "After this tool succeeds, tell the customer that the request has been raised with human staff.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      async execute() {
        const supabase = resolvePancakeSupabaseOptions(agentConfig.channels?.pancake?.options);
        if (!supabase) {
          throw new Error("pancake_handoff_to_human requires config.channels.pancake.options.supabase");
        }
        if (!context.conversationKey.includes(":pancake:")) {
          throw new Error("pancake_handoff_to_human only supports Pancake conversations");
        }

        const result = await setPancakeSupabaseReplyModeToHuman(supabase, context.conversationKey);
        return {
          type: "text",
          value: [
            result.changed
              ? "reply_mode changed from auto to human."
              : "reply_mode was not changed because the current mode is not auto.",
            "Tell the customer that the request has been raised with human staff and staff will follow up.",
          ].join(" "),
        };
      },
    }),
  };
}
