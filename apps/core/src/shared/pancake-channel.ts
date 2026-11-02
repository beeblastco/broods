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
  parseChannelWebhookBody,
} from "./channels.ts";
import { logDebug, logInfo, logWarn } from "./log.ts";
import { contentTypeForPath } from "./media-types.ts";
import { PANCAKE_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const PANCAKE_API_BASE = "https://pages.fm/api/public_api/v1/";

interface PancakeApiResponse {
  id?: string;
  success?: boolean;
  message?: string;
}

interface PancakeConversation {
  id?: string;
  type?: string;
  tags?: unknown[];
  from?: {
    id?: string;
    name?: string;
  };
}

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
  // No tag policy is baked in: an onMessageReceived hook drops by tag.
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
    sendFiles: sendAttachments,
    sendImages: sendAttachments,
    sendTyping: async function () {
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

    // Pancake signs nothing: the webhook URL carries the secret as ?secret=.
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

// Pancake takes one uploaded content id per message, so each file is its own message.
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
  const contentId = body?.id;
  if (!response.ok || !contentId) {
    throw new Error(
      `Pancake upload of ${name} failed (${response.status}): ${formatPancakeError(body, bodyText)}`,
    );
  }

  return contentId;
}

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

  logDebug("Pancake send message succeeded", {
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
  body: PancakeApiResponse | null,
  bodyText: string,
): string {
  return body?.message ?? (bodyText || "unknown_error");
}

// Pancake reuses a message id across edits, so the event id folds in the text and the
// attachment URLs, or two captionless photos would dedupe as one.
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

function parseJsonBody(text: string): PancakeApiResponse | null {
  if (!text) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const body = parsed as Record<string, unknown>;

    return {
      ...(typeof body.id === "string" && body.id ? { id: body.id } : {}),
      ...(typeof body.success === "boolean" ? { success: body.success } : {}),
      ...(typeof body.message === "string" ? { message: body.message } : {}),
    };
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
  const body = parseChannelWebhookBody<PancakeWebhookPayload>(
    "pancake",
    req.body,
  );
  if (body.kind === "ignore") {
    return body;
  }
  const payload = body.payload;
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

  const dropReason = pancakeDropReason(message, pageId);
  if (dropReason) {
    logDebug("Pancake webhook ignored", {
      reason: dropReason,
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

  const fromName = message.from?.name ?? conversation.from?.name;
  const tagIds = normalizePancakeTagIds(conversation.tags);
  logInfo("Pancake webhook accepted", {
    pageId: pageId,
    conversationId: conversation.id,
    messageId: message.id,
    messageType: message.type,
    textLength: text?.length ?? 0,
    attachmentCount: attachments.length,
    tagIds: tagIds,
  });

  const source: PancakeSource = {
    pageId: pageId,
    conversationId: conversation.id,
    messageId: message.id,
    messageType: message.type,
    postId: payload.data?.post?.id,
    fromId: fromId,
    fromName: fromName,
    pageCustomerId: message.from?.page_customer_id,
    tagIds: tagIds,
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
        ...(fromId ? { userId: fromId } : {}),
        ...(fromName ? { userName: fromName } : {}),
      },
      // Spread: an interface is not assignable to Record<string, unknown>.
      source: { ...source },
    },
  };
}

function pancakeDropReason(
  message: PancakeMessage,
  pageId: string,
): string | undefined {
  if (message.is_hidden) {
    return "hidden_message";
  }
  if (message.is_removed) {
    return "removed_message";
  }
  if (message.from?.id === pageId) {
    return "page_originated_message";
  }
  if (!message.from?.page_customer_id) {
    return "missing_page_customer_id";
  }

  return undefined;
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
