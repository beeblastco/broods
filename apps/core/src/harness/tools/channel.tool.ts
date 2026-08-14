/**
 * Model-facing chat channel tools.
 * Keep provider credentials and routing out of model input.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { ChannelActions } from "../../shared/channels.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type {
  RunSessionMessageDispatch,
  SessionMessageInput,
} from "../ingress.ts";
import {
  resolveWorkspace,
  toWorkspaceRelative,
  workspaceMediaUrl,
  workspaceParamSchema,
} from "./filesystem-utils.ts";
import { toolError, toolText } from "./utils.ts";

export interface ChannelToolContext {
  actions: ChannelActions;
  channelName: string;
  transformText(text: string): Promise<string | null>;
  // Attached workspaces, so send-image can take a workspace file instead of a
  // public URL. Needs the owning account to seal the media link, so both arrive
  // together or not at all.
  workspaces?: ResolvedWorkspace[];
  accountId?: string;
}

interface SendImageInput {
  url?: string;
  file_path?: string;
  workspace?: string;
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
  // A workspace file can only be handed over as a media link, which has to name
  // its account; without one the tool stays URL-only rather than half-working.
  const accountId = context.accountId;
  const workspaces = accountId ? (context.workspaces ?? []) : [];

  return {
    "send-image": tool({
      description: sendImageDescription(channelName, workspaces.length > 0),
      inputSchema: jsonSchema<SendImageInput>(sendImageSchema(workspaces)),
      execute: async function (input): Promise<string> {
        const { url, file_path, workspace, caption } = input;
        const photo = await resolveImageUrl(
          { workspaces: workspaces, accountId: accountId },
          url,
          file_path,
          workspace,
        );
        const transformed = await context.transformText(caption ?? "");
        if (transformed === null) {
          return toolText("Image blocked by the outbound message hook.");
        }
        await sendImage(photo, transformed || undefined);

        return toolText(
          `Image sent to the current ${channelName} conversation.`,
        );
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

        return toolText(
          `Message ${result.status} for conversation ${result.conversationKey}.`,
        );
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

        return toolText(
          `Reaction added to the inbound ${channelName} message.`,
        );
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

        return toolText(
          `Sticker sent to the current ${channelName} conversation.`,
        );
      },
    }),
  };
}

// A workspace file has no address of its own, so it is handed over as a durable
// media link — every provider fetches the picture itself rather than accepting
// an upload, and Zalo re-fetches it long after the message was sent.
async function resolveImageUrl(
  source: { workspaces: ResolvedWorkspace[]; accountId?: string },
  url: string | undefined,
  filePath: string | undefined,
  workspace: string | undefined,
): Promise<string> {
  // Two sources name two different pictures. Picking one silently would send
  // something the caller did not ask for, so refuse and let the model choose.
  if (filePath && url) {
    return toolError("Error: send-image takes file_path or url, not both");
  }
  if (filePath) {
    const ws = resolveWorkspace(source.workspaces, workspace);
    if (!ws || !source.accountId) {
      return toolError("Error: no workspace attached");
    }

    return await workspaceMediaUrl(
      ws,
      toWorkspaceRelative(filePath),
      source.accountId,
    );
  }
  if (!url) {
    return toolError(
      "Error: send-image needs either file_path (a workspace file) or url (a public image URL)",
    );
  }

  return url;
}

function sendImageDescription(
  channelName: string,
  hasWorkspace: boolean,
): string {
  const source = hasWorkspace
    ? "Pass exactly one source: file_path for an image in the workspace, or url for one already published on the web."
    : "Pass url, an image already published on the web.";

  return `Sends an image to the current ${channelName} conversation immediately. ${source} Use this for an intentional image message; the normal final text answer is delivered automatically.`;
}

function sendImageSchema(workspaces: ResolvedWorkspace[]): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(workspaces);

  return {
    type: "object",
    properties: {
      ...(workspaces.length > 0
        ? {
            file_path: {
              type: "string",
              description:
                "Path to an image file in the workspace, relative to the workspace root.",
            },
          }
        : {}),
      url: {
        type: "string",
        description:
          "Absolute public http(s) URL of the image the chat provider can fetch.",
      },
      caption: {
        type: "string",
        description: "Optional text shown with the image.",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    additionalProperties: false,
  };
}
