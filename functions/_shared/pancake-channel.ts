/**
 * Pancake channel adapter.
 * Keep Pancake webhook normalization and outbound message API calls here.
 */

import { createHash } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  ChannelRequest,
  ParsedChannelMessage,
} from "./channels.ts";
import { logInfo, logWarn } from "./log.ts";
import { accountAgentScopedKey, PANCAKE_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const SUPABASE_REST_PATH = "rest/v1/";

type ReplyMode = "auto" | "human" | "paused";

interface PancakeWebhookPayload {
  page_id?: string;
  event_type?: string;
  data?: {
    conversation?: PancakeConversation;
    message?: PancakeMessage;
    post?: PancakePost | null;
  };
}

interface PancakeConversation {
  id?: string;
  type?: string;
  from?: {
    id?: string;
    name?: string;
  };
}

interface PancakeMessage {
  id?: string;
  conversation_id?: string;
  page_id?: string;
  message?: string;
  original_message?: string;
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
}

export interface PancakeSupabaseOptions {
  url: string;
  serviceRoleKey: string;
}

export interface PancakeChannelOptions {
  accountId?: string;
  agentId?: string;
  configOptions?: Record<string, unknown>;
}

interface ConversationStateRecord {
  conversation_key: string;
  reply_mode: ReplyMode;
}

export function createPancakeChannel(
  pageId: string,
  pageAccessToken: string,
  senderId?: string,
  options: PancakeChannelOptions = {},
): ChannelAdapter {
  const supabase = resolvePancakeSupabaseOptions(options.configOptions);

  return {
    name: "pancake",

    canHandle(req) {
      return req.method === "POST";
    },

    authenticate() {
      return true;
    },

    parse(req): ChannelParseResult | Promise<ChannelParseResult> {
      const parsed = parsePancakeWebhook(req, pageId);
      if (parsed.kind !== "message" || !supabase) {
        return parsed;
      }

      return applyPancakeSupabaseReplyMode(supabase, options, parsed);
    },

    actions(msg): ChannelActions {
      return createPancakeActions(pageAccessToken, toPancakeSource(msg.source), senderId);
    },
  };
}

function resolvePancakeSupabaseOptions(configOptions: Record<string, unknown> | undefined): PancakeSupabaseOptions | null {
  const supabase = configOptions?.supabase;
  if (!supabase || typeof supabase !== "object" || Array.isArray(supabase)) {
    return null;
  }

  const record = supabase as Record<string, unknown>;
  if (typeof record.url !== "string" || typeof record.serviceRoleKey !== "string") {
    return null;
  }

  const url = record.url.trim();
  const serviceRoleKey = record.serviceRoleKey.trim();
  if (!url || !serviceRoleKey) {
    return null;
  }

  return { url, serviceRoleKey };
}

function parsePancakeWebhook(req: ChannelRequest, pageId: string): ChannelParseResult {
  const payload = JSON.parse(req.body) as PancakeWebhookPayload;

  if (payload.event_type !== "messaging") {
    return { kind: "ignore" };
  }

  if (payload.page_id !== pageId) {
    logWarn("Pancake page not in allow list", { pageId: payload.page_id });
    return { kind: "ignore" };
  }

  const conversation = payload.data?.conversation;
  const message = payload.data?.message;
  const text = message?.message?.trim();
  if (!conversation?.id || !message?.id || !text || !isPancakeMessageType(message.type)) {
    return { kind: "ignore" };
  }

  if (message.is_hidden || message.is_removed || message.from?.id === pageId) {
    return { kind: "ignore" };
  }

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${PANCAKE_INTEGRATION_PREFIX}${pageId}:${message.id}:${hashEventText(text)}`,
      conversationKey: `${PANCAKE_INTEGRATION_PREFIX}${pageId}:${conversation.id}`,
      channelName: "pancake",
      content: [{ type: "text", text }],
      source: {
        pageId,
        conversationId: conversation.id,
        messageId: message.id,
        messageType: message.type,
        postId: payload.data?.post?.id,
        fromId: message.from?.id ?? conversation.from?.id,
        fromName: message.from?.name ?? conversation.from?.name,
        pageCustomerId: message.from?.page_customer_id,
      } satisfies PancakeSource,
    },
  };
}

async function applyPancakeSupabaseReplyMode(
  config: PancakeSupabaseOptions,
  options: PancakeChannelOptions,
  parsed: ParsedChannelMessage,
): Promise<ChannelParseResult> {
  if (!options.accountId || !options.agentId) {
    throw new Error("Pancake Supabase options require accountId and agentId");
  }

  const conversationKey = accountAgentScopedKey(
    options.accountId,
    options.agentId,
    parsed.message.conversationKey,
  );
  const replyMode = await getPancakeSupabaseReplyMode(config, conversationKey);

  if (replyMode === "auto") {
    return parsed;
  }

  logInfo("Pancake Supabase reply mode skipped agent reply", {
    accountId: options.accountId,
    agentId: options.agentId,
    conversationKey,
    replyMode,
  });

  return {
    kind: "ignore",
    response: parsed.ack ?? { statusCode: 200 },
  };
}

export async function getPancakeSupabaseReplyMode(
  config: PancakeSupabaseOptions,
  conversationKey: string,
): Promise<ReplyMode> {
  const state = await upsertConversationState(config, conversationKey);
  return state.reply_mode;
}

export function createPancakeActions(
  pageAccessToken: string,
  source: PancakeSource,
  senderId?: string,
): ChannelActions {
  return {
    sendText: (text) => sendPancakeMessage(pageAccessToken, source, text, senderId),
    async sendTyping() {
      return;
    },
    async reactToMessage() {
      return;
    },
  };
}

async function sendPancakeMessage(
  pageAccessToken: string,
  source: PancakeSource,
  text: string,
  senderId?: string,
): Promise<void> {
  const url = new URL(
    `https://pages.fm/api/public_api/v1/pages/${encodeURIComponent(source.pageId)}/conversations/${
      encodeURIComponent(source.conversationId)
    }/messages`,
  );
  url.searchParams.set("page_access_token", pageAccessToken);

  const payload = source.messageType === "COMMENT"
    ? {
      action: "reply_comment",
      message_id: source.messageId,
      message: text,
      ...(senderId ? { sender_id: senderId } : {}),
    }
    : {
      action: "reply_inbox",
      message: text,
      ...(senderId ? { sender_id: senderId } : {}),
    };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok || body?.success === false) {
    throw new Error(
      `Pancake send message failed (${response.status}): ${formatPancakeError(body, bodyText)}`,
    );
  }
}

async function upsertConversationState(
  config: PancakeSupabaseOptions,
  conversationKey: string,
): Promise<ConversationStateRecord> {
  const params = new URLSearchParams({
    on_conflict: "conversation_key",
    select: "conversation_key,reply_mode",
  });
  const [state] = await supabaseRequest<ConversationStateRecord[]>(
    config,
    `conversation_states?${params}`,
    {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        conversation_key: conversationKey,
      }),
    },
  ) ?? [];

  if (!state) {
    throw new Error("Supabase conversation state upsert returned no row");
  }

  return state;
}

async function supabaseRequest<T>(
  config: PancakeSupabaseOptions,
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const response = await fetch(supabaseUrl(config.url, path), {
    ...init,
    headers: {
      "Accept": "application/json",
      "apikey": config.serviceRoleKey,
      "Authorization": `Bearer ${config.serviceRoleKey}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${bodyText || "empty response"}`);
  }

  if (!bodyText.trim()) {
    return null;
  }

  return JSON.parse(bodyText) as T;
}

function supabaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${SUPABASE_REST_PATH}${path.replace(/^\/+/, "")}`, base).toString();
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
    pageCustomerId: typeof source.pageCustomerId === "string" ? source.pageCustomerId : undefined,
  };
}

function isPancakeMessageType(value: unknown): value is PancakeSource["messageType"] {
  return value === "INBOX" || value === "COMMENT";
}

function hashEventText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function parseJsonBody(text: string): { success?: boolean; message?: string } | null {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { success?: boolean; message?: string } : null;
  } catch {
    return null;
  }
}

function formatPancakeError(body: { message?: string } | null, bodyText: string): string {
  return body?.message ?? (bodyText || "unknown_error");
}
