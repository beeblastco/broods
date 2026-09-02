/**
 * Model-facing chat channel tools.
 * Keep provider credentials and routing out of model input.
 */

import { jsonSchema, tool, type JSONSchema7, type ToolSet } from "ai";
import type { Attachment } from "chat";
import {
  channelAttachmentName,
  type ChannelActions,
  type ChannelFile,
  type ChannelImage,
} from "../../shared/channels.ts";
import { logWarn } from "../../shared/log.ts";
import { contentTypeForPath } from "../../shared/media-types.ts";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import type {
  RunSessionMessageDispatch,
  SessionMessageInput,
} from "../ingress.ts";
import {
  resolveWorkspace,
  toWorkspaceRelative,
  workspaceMediaBytes,
  workspaceMediaUrl,
  workspaceParamSchema,
} from "./filesystem-utils.ts";
import { toolError, toolText } from "./utils.ts";

// Every provider that takes a batch has its own ceiling — Telegram ten per
// album, Discord ten files a message — and when a provider uploads, the bytes of
// every file in one call are resident at once. So the cap is a memory ceiling as
// much as a protocol one.
const MAX_ATTACHMENTS_PER_CALL = 10;

export interface ChannelToolContext {
  actions: ChannelActions;
  channelName: string;
  transformText(text: string): Promise<string | null>;
  // Attached workspaces, so send-images and send-files can take a workspace
  // file instead of a public URL. Sealing that link needs the owning account,
  // so both arrive together or not at all.
  workspaces?: ResolvedWorkspace[];
  accountId?: string;
}

interface SendFilesInput {
  file_paths: string[];
  workspace?: string;
  caption?: string;
}

interface SendImagesInput {
  urls?: string[];
  file_paths?: string[];
  workspace?: string;
  caption?: string;
}

interface SendReactionInput {
  emoji?: string;
}

interface SendStickerInput {
  sticker: string;
}

interface SendUpdateInput {
  message: string;
}

// Documents, by the same sealed media link `send-images` hands pictures over as.
// Two deliveries behind one tool: a provider with a document API gets the files
// themselves, and one without gets their URLs as text. The model picks neither —
// it names workspace paths and the channel decides, so a prompt written for one
// channel keeps working on the next.
export function sendFilesTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;
  // A workspace file can only leave as a media link, and sealing one needs the
  // owning account. Without workspaces there is nothing this tool could send.
  const accountId = context.accountId;
  const workspaces = accountId ? (context.workspaces ?? []) : [];
  if (workspaces.length === 0) {
    // Without this line the drop is invisible in the trace. `sendImages` names
    // what the same missing workspace did to the other half of the pair.
    logWarn(
      "send-files not registered: sending files needs an attached workspace",
      {
        channel: channelName,
        attachedWorkspaces: context.workspaces?.length ?? 0,
        sendImages:
          actions.sendImages || actions.sendFiles
            ? "url-only"
            : "not-registered",
      },
    );

    return {};
  }
  return {
    "send-files": tool({
      description: sendFilesDescription(
        channelName,
        actions.sendFiles !== undefined,
      ),
      inputSchema: jsonSchema<SendFilesInput>(sendFilesSchema(workspaces)),
      execute: async function (input): Promise<string> {
        const { file_paths, workspace, caption } = input;
        if (file_paths.length === 0) {
          return toolError("Error: send-files needs at least one file_path");
        }
        const ws = resolveWorkspace(workspaces, workspace);
        if (!ws || !accountId) {
          return toolError("Error: no workspace attached");
        }
        const files = await Promise.all(
          file_paths.map((path): Promise<ChannelFile> =>
            workspaceAttachment("file", ws, path, accountId),
          ),
        );
        const transformed = await context.transformText(caption ?? "");
        if (transformed === null) {
          return toolText("Files blocked by the outbound message hook.");
        }

        return await deliverFiles(context, files, transformed);
      },
    }),
  };
}

// Pictures, by the same sealed media link `send-files` hands documents over as.
// A picture is a different message from a file — the recipient sees it without
// opening anything — so it gets its own tool and its own provider endpoint. It
// degrades rather than fails: a channel with no picture endpoint, or one that
// rejects the batch, still delivers through `send-files`, because the recipient
// would rather have the file than an apology.
export function sendImagesTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;
  // A channel with neither endpoint cannot deliver a picture as anything but a
  // bare link, which is what `send-files` is already for. Offering a picture
  // tool that never sends one would just mislead the model.
  if (!actions.sendImages && !actions.sendFiles) {
    return {};
  }
  // A workspace file can only be handed over as a media link, which has to name
  // its account; without one the tool stays URL-only rather than half-working.
  // `sendFilesTool` already warns for that cause.
  const accountId = context.accountId;
  const workspaces = accountId ? (context.workspaces ?? []) : [];

  return {
    "send-images": tool({
      description: sendImagesDescription(
        channelName,
        workspaces.length > 0,
        actions.sendImages !== undefined,
      ),
      inputSchema: jsonSchema<SendImagesInput>(sendImagesSchema(workspaces)),
      execute: async function (input): Promise<string> {
        const { urls, file_paths, workspace, caption } = input;
        const images = await resolveImages(
          { workspaces: workspaces, accountId: accountId },
          urls,
          file_paths,
          workspace,
        );
        const transformed = await context.transformText(caption ?? "");
        if (transformed === null) {
          return toolText("Images blocked by the outbound message hook.");
        }
        if (actions.sendImages) {
          try {
            await actions.sendImages(images, transformed || undefined);

            return toolText(
              `${images.length} image(s) sent to the current ${channelName} conversation.`,
            );
          } catch (error) {
            // The provider took the batch and refused it. The reason belongs in
            // the log, not the conversation; the recipient gets the pictures by
            // the next route down rather than an error.
            logWarn("Channel rejected an image batch, falling back to files", {
              channel: channelName,
              count: images.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return await deliverFiles(
          context,
          images.map(toChannelFile),
          transformed,
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

// A progress note while the turn is still running, so a long tool run does not
// read as a dead bot. It carries none of the answer and is not a delivery tool:
// the turn still owes a final reply after it.
export function sendUpdateTool(context: ChannelToolContext): ToolSet {
  const { actions, channelName } = context;

  return {
    "send-update": tool({
      description: `Sends a short progress note to the current ${channelName} conversation right now, while the turn keeps running. Use it when the work ahead will take long enough that the recipient would otherwise wait with no sign anything is happening: say what is being done and how long it is likely to take. This is not the answer, which is still delivered when the turn ends, so keep it to a sentence or two and do not repeat an update that is still true.`,
      inputSchema: jsonSchema<SendUpdateInput>({
        type: "object",
        properties: {
          message: {
            type: "string",
            minLength: 1,
            description:
              "Progress note to send now, written in the language of the conversation.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<string> {
        const transformed = await context.transformText(input.message);
        if (transformed === null) {
          return toolText("Update blocked by the outbound message hook.");
        }
        await actions.sendText(transformed);

        return toolText(
          `Update sent to the current ${channelName} conversation. The final reply is still owed.`,
        );
      },
    }),
  };
}

// The last two rungs both tools share: hand the documents to the provider, and
// if it has none, post the sealed links as text. The tool result names which
// happened so the model does not send them a second time.
async function deliverFiles(
  context: ChannelToolContext,
  files: ChannelFile[],
  caption: string,
): Promise<string> {
  const { actions, channelName } = context;
  if (actions.sendFiles) {
    try {
      await actions.sendFiles(files, caption || undefined);

      return toolText(
        `${files.length} file(s) sent to the current ${channelName} conversation.`,
      );
    } catch (error) {
      // Uploading is the rung that can fail on the provider's terms rather than
      // ours: Discord caps a free guild at 10 MB and Slack needs files:write on
      // the token. The link below needs neither, so it is worth trying before
      // giving the recipient nothing.
      logWarn("Channel rejected a file upload, falling back to links", {
        channel: channelName,
        count: files.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const lines = files.map((file): string => `${file.name}: ${file.url}`);
  await actions.sendText(
    caption ? `${caption}\n${lines.join("\n")}` : lines.join("\n"),
  );

  return toolText(
    `${channelName} could not attach documents, so ${files.length} download link(s) were sent as text instead. Do not send them again.`,
  );
}

// A workspace file has no address of its own, so it is handed over as a durable
// media link — every provider fetches the picture itself rather than accepting
// an upload, and Zalo re-fetches it long after the message was sent.
async function resolveImages(
  source: { workspaces: ResolvedWorkspace[]; accountId?: string },
  urls: string[] | undefined,
  filePaths: string[] | undefined,
  workspace: string | undefined,
): Promise<ChannelImage[]> {
  // Two sources name two different sets of pictures. Picking one silently would
  // send something the caller did not ask for, so refuse and let the model
  // choose.
  if (filePaths?.length && urls?.length) {
    return toolError("Error: send-images takes file_paths or urls, not both");
  }
  if (filePaths?.length) {
    const ws = resolveWorkspace(source.workspaces, workspace);
    const accountId = source.accountId;
    if (!ws || !accountId) {
      return toolError("Error: no workspace attached");
    }

    return await Promise.all(
      filePaths.map((path): Promise<ChannelImage> =>
        workspaceAttachment("image", ws, path, accountId),
      ),
    );
  }
  if (!urls?.length) {
    return toolError(
      "Error: send-images needs either file_paths (workspace files) or urls (public image URLs)",
    );
  }

  return urls.map((url): ChannelImage => {
    const name = channelAttachmentName({ type: "image", url: url });

    return {
      type: "image",
      url: url,
      name: name,
      mimeType: contentTypeForPath(name),
    };
  });
}

function sendFilesDescription(channelName: string, native: boolean): string {
  const delivery = native
    ? `The files are attached to the ${channelName} conversation.`
    : `${channelName} has no document attachment, so the files are posted as download links the recipient opens themselves.`;

  return `Sends one or more workspace documents to the current ${channelName} conversation immediately. ${delivery} Use it for anything that is not a picture: PDFs, spreadsheets, and text files. Pictures go through send-images instead.`;
}

function sendFilesSchema(workspaces: ResolvedWorkspace[]): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(workspaces);

  return {
    type: "object",
    properties: {
      file_paths: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_ATTACHMENTS_PER_CALL,
        description:
          "Paths to files in the workspace, each relative to the workspace root.",
      },
      caption: {
        type: "string",
        description: "Optional text shown with the files.",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    required: ["file_paths"],
    additionalProperties: false,
  };
}

function sendImagesDescription(
  channelName: string,
  hasWorkspace: boolean,
  native: boolean,
): string {
  const source = hasWorkspace
    ? "Pass exactly one source: file_paths for images in the workspace, or urls for ones already published on the web."
    : "Pass urls, images already published on the web.";
  const delivery = native
    ? `They arrive inline, so the recipient sees them without opening anything. Send a whole set in one call rather than one call per picture; ${channelName} decides how to group them.`
    : `${channelName} cannot show pictures inline, so they are delivered as files to download instead.`;

  return `Sends one or more images to the current ${channelName} conversation immediately. ${source} ${delivery} Use this for an intentional image message; the normal final text answer is delivered automatically. Documents that are not pictures go through send-files.`;
}

function sendImagesSchema(workspaces: ResolvedWorkspace[]): JSONSchema7 {
  const workspaceProp = workspaceParamSchema(workspaces);

  return {
    type: "object",
    properties: {
      ...(workspaces.length > 0
        ? {
            file_paths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: MAX_ATTACHMENTS_PER_CALL,
              description:
                "Paths to image files in the workspace, each relative to the workspace root.",
            },
          }
        : {}),
      urls: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_ATTACHMENTS_PER_CALL,
        description:
          "Absolute public http(s) URLs of images the chat provider can fetch.",
      },
      caption: {
        type: "string",
        description: "Optional text shown with the images.",
      },
      ...(workspaceProp ? { workspace: workspaceProp as JSONSchema7 } : {}),
    },
    additionalProperties: false,
  };
}

// The same picture, offered as something to download instead of something to
// look at. Only the delivery changes; the sealed link is the one already minted.
function toChannelFile(image: ChannelImage): ChannelFile {
  return { ...image, type: "file" };
}

// One workspace file, addressed both ways a provider might want it: the sealed
// link for the ones that fetch, and a reader for the ones that upload. The
// reader stays uncalled unless a provider asks, which keeps the object off the
// wire for Telegram and Zalo.
async function workspaceAttachment<T extends "file" | "image">(
  type: T,
  ws: ResolvedWorkspace,
  path: string,
  accountId: string,
): Promise<Attachment & { type: T; url: string }> {
  const rel = toWorkspaceRelative(path);

  return {
    type: type,
    url: await workspaceMediaUrl(ws, rel, accountId),
    name: rel.split("/").pop() || rel,
    mimeType: contentTypeForPath(rel),
    fetchData: async (): Promise<Buffer> =>
      Buffer.from(await workspaceMediaBytes(ws, rel)),
  };
}
