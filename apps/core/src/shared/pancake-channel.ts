/**
 * Pancake channel adapter.
 * Keep Pancake webhook normalization and outbound message API calls here.
 *
 * Per-conversation policy (e.g. skipping human-owned conversations by tag) is
 * not baked in: the parsed source carries `tagIds` so a user `onMessageReceived`
 * hook can decide to drop the message.
 */

import { createHash } from "node:crypto";
import { timingSafeStringEqual } from "./auth.ts";
import type { Attachment } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelFile,
  ChannelImage,
  ChannelParseResult,
  ChannelRequest,
} from "./channels.ts";
import {
  channelAttachmentBytes,
  channelAttachmentName,
  isAllowedId,
} from "./channels.ts";
import { logDebug, logInfo, logWarn } from "./log.ts";
import { contentTypeForPath } from "./media-types.ts";
import { PANCAKE_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const PANCAKE_API_BASE = "https://pages.fm/api/public_api/v1/";

interface PancakeConversation {
  id?: string;
  type?: string;
  tags?: unknown[];
  from?: {
    id?: string;
    name?: string;
  };
}

/**
 * One item in a Pancake message's `attachments` array. A photo names its URL
 * directly; a video hides it one level down in `video_data`. Anything else —
 * a share card, a fallback link preview — has no file behind it.
 */
interface PancakeAttachment {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  mime_type?: string;
  video_data?: { url?: string };
}

interface PancakeMessage {
  id?: string;
  conversation_id?: string;
  page_id?: string;
  message?: string;
  original_message?: string;
  attachments?: PancakeAttachment[];
  type?: string;
  inserted_at?: string;
  from?: {
    id?: string;
    name?: string;
    page_customer_id?: string;
  };
  is_hidden?: boolean;
  is_removed?: boolean;
}

interface PancakePost {
  id?: string;
}

export interface PancakeSource {
  pageId: string;
  conversationId: string;
  messageId: string;
  messageType: "INBOX" | "COMMENT";
  postId?: string;
  fromId?: string;
  fromName?: string;
  pageCustomerId?: string;
  tagIds?: string[];
}

interface PancakeWebhookPayload {
  page_id?: string;
  event_type?: string;
  data?: {
    conversation?: PancakeConversation;
    message?: PancakeMessage;
    post?: PancakePost | null;
  };
}

export function createPancakeActions(
  pageAccessToken: string,
  source: PancakeSource,
  senderId?: string,
): ChannelActions {
  const sendAttachments = (
    attachments: ChannelFile[] | ChannelImage[],
    caption?: string,
  ): Promise<void> =>
    sendPancakeAttachments(
      pageAccessToken,
      source,
      attachments,
      caption,
      senderId,
    );

  return {
    sendText: (text) =>
      sendPancakeMessage(pageAccessToken, source, text, senderId),
    // Pancake uploads both the same way and lets the recipient's client decide
    // what to preview, so one body serves each.
    sendFiles: sendAttachments,
    sendImages: sendAttachments,
    sendTyping: async function() {
      return;
    },
    reactToMessage: async function () {
      return;
    },
  };
}

export function createPancakeChannel(
  pageId: string,
  pageAccessToken: string,
  webhookSecret: string,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
  senderId?: string,
): ChannelAdapter {
  return {
    name: "pancake",

    canHandle: function (req) {
      return req.method === "POST";
    },

    // Pancake sends no signature header; the webhook URL carries the secret as
    // a ?secret= query parameter instead.
    authenticate: function (req) {
      const provided = new URLSearchParams(req.rawQueryString).get("secret");

      return (
        Boolean(provided) && timingSafeStringEqual(provided!, webhookSecret)
      );
    },

    parse: function (req): ChannelParseResult | Promise<ChannelParseResult> {
      return parsePancakeWebhook(
        req,
        pageId,
        allowedChannelIds,
        allowedUserIds,
      );
    },

    actions: function (msg): ChannelActions {
      return createPancakeActions(
        pageAccessToken,
        toPancakeSource(msg.source),
        senderId,
      );
    },
  };
}

async function sendPancakeMessage(
  pageAccessToken: string,
  source: PancakeSource,
  text: string,
  senderId?: string,
): Promise<void> {
  logDebug("Pancake send message request", {
    pageId: source.pageId,
    conversationId: source.conversationId,
    messageType: source.messageType,
    replyToMessageId: source.messageId,
    hasSenderId: Boolean(senderId),
    textLength: text.length,
  });
  await postPancakeMessage(pageAccessToken, source, {
    message: text,
    ...(senderId ? { sender_id: senderId } : {}),
  });
}

/**
 * Sends pictures or documents on Pancake, which takes neither directly.
 *
 * Every file goes up to `upload_contents` first and comes back as a content id,
 * and the message then references those ids. Pancake accepts one content id per
 * message, so a batch becomes a batch of messages — the caption rides the first,
 * because repeating it once per file reads as the same message sent over again.
 */
async function sendPancakeAttachments(
  pageAccessToken: string,
  source: PancakeSource,
  attachments: ChannelFile[] | ChannelImage[],
  caption?: string,
  senderId?: string,
): Promise<void> {
  for (const [index, attachment] of attachments.entries()) {
    const contentId = await uploadPancakeContent(
      pageAccessToken,
      source.pageId,
      attachment,
    );
    const text = index === 0 ? caption?.trim() : undefined;
    await postPancakeMessage(pageAccessToken, source, {
      content_ids: [contentId],
      ...(text ? { message: text } : {}),
      ...(senderId ? { sender_id: senderId } : {}),
    });
  }
}

async function uploadPancakeContent(
  pageAccessToken: string,
  pageId: string,
  attachment: ChannelFile | ChannelImage,
): Promise<string> {
  const name = channelAttachmentName(attachment);
  const form = new FormData();
  form.set(
    "file",
    new File([await channelAttachmentBytes(attachment)], name, {
      type: attachment.mimeType ?? contentTypeForPath(name),
    }),
  );
  const response = await fetch(
    pancakeApiUrl(
      `pages/${encodeURIComponent(pageId)}/upload_contents`,
      pageAccessToken,
    ),
    { method: "POST", body: form },
  );
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);
  // The upload answers with a top-level id; anything else is a failed upload
  // whatever the status code says.
  const contentId =
    typeof body?.id === "string" && body.id ? body.id : undefined;
  if (!response.ok || !contentId) {
    throw new Error(
      `Pancake upload of ${name} failed (${response.status}): ${formatPancakeError(body, bodyText)}`,
    );
  }

  return contentId;
}

// The one POST both a text reply and an attachment reply go through. `action`
// is not the caller's to choose: a comment must be answered as a comment and an
// inbox message as an inbox message, and that is decided by where it came from.
async function postPancakeMessage(
  pageAccessToken: string,
  source: PancakeSource,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = pancakeApiUrl(
    `pages/${encodeURIComponent(source.pageId)}/conversations/${encodeURIComponent(
      source.conversationId,
    )}/messages`,
    pageAccessToken,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      source.messageType === "COMMENT"
        ? {
            action: "reply_comment",
            message_id: source.messageId,
            ...payload,
          }
        : { action: "reply_inbox", ...payload },
    ),
  });
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok || body?.success === false) {
    logWarn("Pancake send message failed", {
      pageId: source.pageId,
      conversationId: source.conversationId,
      status: response.status,
      error: formatPancakeError(body, bodyText),
    });
    throw new Error(
      `Pancake send message failed (${response.status}): ${formatPancakeError(body, bodyText)}`,
    );
  }

  logInfo("Pancake send message succeeded", {
    pageId: source.pageId,
    conversationId: source.conversationId,
    status: response.status,
    responseMessage: body?.message,
  });
}

function pancakeApiUrl(path: string, pageAccessToken: string): URL {
  const url = new URL(path, PANCAKE_API_BASE);
  url.searchParams.set("page_access_token", pageAccessToken);

  return url;
}

function formatPancakeError(
  body: { message?: string } | null,
  bodyText: string,
): string {
  return body?.message ?? (bodyText || "unknown_error");
}

// Pancake reuses a message id across edits, so the event id folds in what the
// message actually said. Attachment identity belongs in it for the same reason:
// two captionless photos would otherwise hash identically and the second would
// dedupe away as a replay of the first.
function hashEventContent(
  text: string | undefined,
  attachments: Attachment[],
): string {
  const identity = [
    text ?? "",
    ...attachments.map((attachment) => attachment.url ?? ""),
  ].join("\n");

  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

/**
 * The photos and videos on a Pancake message, as Chat SDK attachments.
 *
 * Pancake hosts every upload itself and names it by URL, so there is no token to
 * attach and nothing to resolve first — the link in the webhook is the file. A
 * share card or link preview arrives in the same array with no file behind it,
 * and is dropped rather than turned into a broken download.
 */
function pancakeAttachments(
  value: PancakeAttachment[] | undefined,
): Attachment[] {
  return (value ?? []).flatMap((attachment): Attachment[] => {
    if (attachment.type !== "photo" && attachment.type !== "video") {
      return [];
    }
    const isPhoto = attachment.type === "photo";
    const url = isPhoto ? attachment.url : attachment.video_data?.url;
    if (!url?.trim()) {
      return [];
    }

    return [
      {
        type: isPhoto ? "image" : "video",
        url: url,
        ...(attachment.title ? { name: attachment.title } : {}),
        ...(attachment.mime_type ? { mimeType: attachment.mime_type } : {}),
      },
    ];
  });
}

function isPancakeMessageType(
  value: unknown,
): value is PancakeSource["messageType"] {
  return value === "INBOX" || value === "COMMENT";
}

function normalizePancakeTagIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((tag) => {
    if (typeof tag === "string" || typeof tag === "number") {
      return [String(tag)];
    }

    return [];
  });
}

function parseJsonBody(
  text: string,
): { id?: unknown; success?: boolean; message?: string } | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    return parsed && typeof parsed === "object"
      ? (parsed as { id?: unknown; success?: boolean; message?: string })
      : null;
  } catch {
    return null;
  }
}

function parsePancakeWebhook(
  req: ChannelRequest,
  pageId: string,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
): ChannelParseResult {
  const payload = JSON.parse(req.body) as PancakeWebhookPayload;
  logDebug("Pancake webhook received", {
    configuredPageId: pageId,
    payloadPageId: payload.page_id,
    eventType: payload.event_type,
    conversationId: payload.data?.conversation?.id,
    messageId: payload.data?.message?.id,
    messageType: payload.data?.message?.type,
    fromId:
      payload.data?.message?.from?.id ?? payload.data?.conversation?.from?.id,
    fromName:
      payload.data?.message?.from?.name ??
      payload.data?.conversation?.from?.name,
    pageCustomerId: payload.data?.message?.from?.page_customer_id,
    tagIds: normalizePancakeTagIds(payload.data?.conversation?.tags),
  });

  if (payload.event_type !== "messaging") {
    logDebug("Pancake webhook ignored", {
      reason: "unsupported_event_type",
      eventType: payload.event_type,
      pageId: payload.page_id,
    });

    return { kind: "ignore" };
  }

  if (payload.page_id !== pageId) {
    logWarn("Pancake page not in allow list", { pageId: payload.page_id });

    return { kind: "ignore" };
  }

  const conversation = payload.data?.conversation;
  const message = payload.data?.message;
  const text = message?.message?.trim();
  const attachments = pancakeAttachments(message?.attachments);
  // A customer who sends only a photo is still a customer asking something.
  if (
    !conversation?.id ||
    !message?.id ||
    (!text && attachments.length === 0) ||
    !isPancakeMessageType(message.type)
  ) {
    logDebug("Pancake webhook ignored", {
      reason: "missing_or_unsupported_message",
      pageId: payload.page_id,
      conversationId: conversation?.id,
      messageId: message?.id,
      hasText: Boolean(text),
      attachmentCount: attachments.length,
      messageType: message?.type,
    });

    return { kind: "ignore" };
  }

  if (
    message.is_hidden ||
    message.is_removed ||
    message.from?.id === pageId ||
    !message.from?.page_customer_id
  ) {
    logDebug("Pancake webhook ignored", {
      reason: message.is_hidden
        ? "hidden_message"
        : message.is_removed
          ? "removed_message"
          : message.from?.id === pageId
            ? "page_originated_message"
            : "missing_page_customer_id",
      pageId: payload.page_id,
      conversationId: conversation.id,
      messageId: message.id,
      fromId: message.from?.id,
      pageCustomerId: message.from?.page_customer_id,
    });

    return { kind: "ignore" };
  }

  if (!isAllowedId(allowedChannelIds, conversation.id)) {
    logWarn("Pancake conversation not in allow list", {
      conversationId: conversation.id,
    });

    return { kind: "ignore" };
  }

  const fromId = message.from?.id ?? conversation.from?.id;
  if (!isAllowedId(allowedUserIds, fromId)) {
    logWarn("Pancake sender not in allow list", { userId: fromId });

    return { kind: "ignore" };
  }

  logInfo("Pancake webhook accepted", {
    pageId: pageId,
    conversationId: conversation.id,
    messageId: message.id,
    messageType: message.type,
    textLength: text?.length ?? 0,
    attachmentCount: attachments.length,
    tagIds: normalizePancakeTagIds(conversation.tags),
  });

  const source: PancakeSource = {
    pageId: pageId,
    conversationId: conversation.id,
    messageId: message.id,
    messageType: message.type,
    postId: payload.data?.post?.id,
    fromId: message.from?.id ?? conversation.from?.id,
    fromName: message.from?.name ?? conversation.from?.name,
    pageCustomerId: message.from?.page_customer_id,
    tagIds: normalizePancakeTagIds(conversation.tags),
  };

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${PANCAKE_INTEGRATION_PREFIX}${pageId}:${message.id}:${hashEventContent(text, attachments)}`,
      conversationKey: `${PANCAKE_INTEGRATION_PREFIX}${pageId}:${conversation.id}`,
      channelName: "pancake",
      content: [{ type: "text", text: text ?? "" }],
      ...(attachments.length > 0 ? { attachments: attachments } : {}),
      identity: {
        workspaceRef: pageId,
        channelId: conversation.id,
        ...((message.from?.id ?? conversation.from?.id)
          ? { userId: message.from?.id ?? conversation.from?.id }
          : {}),
        ...((message.from?.name ?? conversation.from?.name)
          ? { userName: message.from?.name ?? conversation.from?.name }
          : {}),
      },
      // Spread so the typed source reaches a Record<string, unknown> field.
      source: { ...source },
    },
  };
}

function toPancakeSource(source: Record<string, unknown>): PancakeSource {
  if (
    typeof source.pageId !== "string" ||
    typeof source.conversationId !== "string" ||
    typeof source.messageId !== "string" ||
    !isPancakeMessageType(source.messageType)
  ) {
    throw new Error("Invalid Pancake source payload");
  }

  return {
    pageId: source.pageId,
    conversationId: source.conversationId,
    messageId: source.messageId,
    messageType: source.messageType,
    postId: typeof source.postId === "string" ? source.postId : undefined,
    fromId: typeof source.fromId === "string" ? source.fromId : undefined,
    fromName: typeof source.fromName === "string" ? source.fromName : undefined,
    pageCustomerId:
      typeof source.pageCustomerId === "string"
        ? source.pageCustomerId
        : undefined,
  };
}
