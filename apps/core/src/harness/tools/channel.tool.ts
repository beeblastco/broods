/**
 * Channel interaction tools for turns that originated in a configured chat channel.
 * Keep provider credentials and routing inside ChannelActions, never in model input.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { ChannelActions } from "../../shared/channels.ts";
import { toolError, toolText, toToolResultOutput } from "./utils.ts";

const IMAGE_SCHEMA: JSONSchema7 = {
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
};
const MESSAGE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "Text to send to the current chat conversation.",
    },
  },
  required: ["text"],
  additionalProperties: false,
};
const REACTION_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    emoji: {
      type: "string",
      description:
        "Optional channel-native emoji name or Unicode emoji. Omit it to use the channel's configured acknowledgement reaction.",
    },
  },
  additionalProperties: false,
};
const STICKER_SCHEMA: JSONSchema7 = {
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
};

export interface ChannelToolContext {
  actions: ChannelActions;
  channelName: string;
  transformText(text: string): Promise<string | null>;
}

interface SendImageInput {
  url: string;
  caption?: string;
}

interface SendMessageInput {
  text: string;
}

interface SendReactionInput {
  emoji?: string;
}

interface SendStickerInput {
  sticker: string;
}

export default function channelTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;

  return {
    "send-image": tool({
      description: `Sends an image to the current ${channelName} conversation immediately. Use this for an intentional image message; the normal final text answer is delivered automatically.`,
      inputSchema: jsonSchema(IMAGE_SCHEMA),
      toModelOutput: toToolResultOutput,
      execute: async function(input): Promise<string> {
        if (!actions.sendImage) {
          return toolError(
            `The ${channelName} channel does not support sending images`,
          );
        }
        const { url, caption } = input as SendImageInput;
        const transformed = await context.transformText(caption ?? "");
        if (transformed === null) {
          return toolText("Image blocked by the outbound message hook.");
        }
        await actions.sendImage(url, transformed || undefined);

        return toolText(
          `Image sent to the current ${channelName} conversation.`,
        );
      },
    }),
    "send-message": tool({
      description: `Sends an additional text message to the current ${channelName} conversation immediately. Do not use it for an ordinary final answer because final answer text is delivered automatically.`,
      inputSchema: jsonSchema(MESSAGE_SCHEMA),
      toModelOutput: toToolResultOutput,
      execute: async function(input): Promise<string> {
        const { text } = input as SendMessageInput;
        const transformed = await context.transformText(text);
        if (transformed === null) {
          return toolText("Message blocked by the outbound message hook.");
        }
        await actions.sendText(transformed);

        return toolText(
          `Message sent to the current ${channelName} conversation.`,
        );
      },
    }),
    "send-reactions": tool({
      description: `Adds a reaction to the inbound message in the current ${channelName} conversation. The provider may accept only its own emoji names or supported Unicode emoji.`,
      inputSchema: jsonSchema(REACTION_SCHEMA),
      toModelOutput: toToolResultOutput,
      execute: async function(input): Promise<string> {
        if (actions.supportsReactions !== true) {
          return toolError(
            `The ${channelName} channel does not support message reactions`,
          );
        }
        const { emoji } = input as SendReactionInput;
        await actions.reactToMessage(emoji);

        return toolText(
          `Reaction added to the inbound ${channelName} message.`,
        );
      },
    }),
    "send-sticker": tool({
      description: `Sends a provider-native sticker to the current ${channelName} conversation immediately. Use a sticker identifier valid for this provider.`,
      inputSchema: jsonSchema(STICKER_SCHEMA),
      toModelOutput: toToolResultOutput,
      execute: async function(input): Promise<string> {
        if (!actions.sendSticker) {
          return toolError(
            `The ${channelName} channel does not support sending stickers`,
          );
        }
        const { sticker } = input as SendStickerInput;
        await actions.sendSticker(sticker);

        return toolText(
          `Sticker sent to the current ${channelName} conversation.`,
        );
      },
    }),
  };
}
