/**
 * Model-facing chat channel tools.
 * Keep provider credentials and routing out of model input.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ChannelActions } from "../../shared/channels.ts";
import type {
  RunSessionMessageDispatch,
  SessionMessageInput,
} from "../ingress.ts";
import { toolText } from "./utils.ts";

export interface ChannelToolContext {
  actions: ChannelActions;
  channelName: string;
  transformText(text: string): Promise<string | null>;
}

interface SendImageInput {
  url: string;
  caption?: string;
}

interface SendReactionInput {
  emoji?: string;
}

interface SendStickerInput {
  sticker: string;
}

export function sendImageTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;
  const sendImage = actions.sendImage;
  if (!sendImage) {
    return {};
  }

  return {
    "send-image": tool({
      description: `Sends an image to the current ${channelName} conversation immediately. Use this for an intentional image message; the normal final text answer is delivered automatically.`,
      inputSchema: jsonSchema<SendImageInput>({
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Absolute public http(s) URL of the image the chat provider can fetch.",
          },
          caption: {
            type: "string",
            description: "Optional text shown with the image.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const { url, caption } = input;
        const transformed = await context.transformText(caption ?? "");
        if (transformed === null) {
          return toolText("Image blocked by the outbound message hook.");
        }
        await sendImage(url, transformed || undefined);

        return toolText(`Image sent to the current ${channelName} conversation.`);
      },
    }),
  };
}

export function sendMessageTool(dispatch: RunSessionMessageDispatch): ToolSet {
  return {
    "send-message": tool({
      description:
        "Sends a message to another conversation session. The target agent processes it as a follow-up and replies in that conversation.",
      inputSchema: jsonSchema<SessionMessageInput>({
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
      }),
      execute: async function (input): Promise<string> {
        const result = await dispatch(input);

        return toolText(`Message ${result.status} for conversation ${result.conversationKey}.`);
      },
    }),
  };
}

export function sendReactionsTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;
  if (actions.supportsReactions !== true) {
    return {};
  }

  return {
    "send-reactions": tool({
      description: `Adds a reaction to the inbound message in the current ${channelName} conversation. The provider may accept only its own emoji names or supported Unicode emoji.`,
      inputSchema: jsonSchema<SendReactionInput>({
        type: "object",
        properties: {
          emoji: {
            type: "string",
            description:
              "Optional channel-native emoji name or Unicode emoji. Omit it to use the channel's configured acknowledgement reaction.",
          },
        },
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const { emoji } = input;
        await actions.reactToMessage(emoji);

        return toolText(`Reaction added to the inbound ${channelName} message.`);
      },
    }),
  };
}

export function sendStickerTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;
  const sendSticker = actions.sendSticker;
  if (!sendSticker) {
    return {};
  }

  return {
    "send-sticker": tool({
      description: `Sends a provider-native sticker to the current ${channelName} conversation immediately. Use a sticker identifier valid for this provider.`,
      inputSchema: jsonSchema<SendStickerInput>({
        type: "object",
        properties: {
          sticker: {
            type: "string",
            description:
              "Provider-native sticker identifier, file identifier, name, or public URL.",
          },
        },
        required: ["sticker"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const { sticker } = input;
        await sendSticker(sticker);

        return toolText(`Sticker sent to the current ${channelName} conversation.`);
      },
    }),
  };
}
