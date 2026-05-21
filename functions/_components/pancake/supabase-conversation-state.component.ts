/**
 * Pancake Supabase conversation-state component.
 * This is optional customer-specific behavior, not part of the channel adapter.
 */

import type { JSONValue, SystemModelMessage } from "ai";
import { extractText } from "../../_shared/channels.ts";
import { logError, logInfo, logWarn } from "../../_shared/log.ts";
import type {
  ChannelHookResult,
  ChannelLifecycleComponent,
  ChannelLifecycleContext,
  ChannelReplyResult,
} from "../../harness-processing/channel-lifecycle/types.ts";

const SUPABASE_REST_PATH = "rest/v1/";

type ReplyMode = "auto" | "human" | "paused";

export interface SupabaseConversationStateConfig {
  url: string;
  serviceRoleKey: string;
}

interface ConversationStateRecord {
  conversation_key: string;
  account_id: string;
  agent_id: string;
  channel: string;
  provider_conversation_id?: string | null;
  customer_external_id?: string | null;
  reply_mode: ReplyMode;
  metadata?: JSONValue;
  last_customer_message_at?: string | null;
  last_agent_reply_at?: string | null;
  last_human_reply_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface PancakeConversationSource {
  pageId: string;
  conversationId: string;
  messageId: string;
  fromId?: string;
  fromName?: string;
  pageCustomerId?: string;
  insertedAt?: string;
  rawPayload?: unknown;
}

class SupabaseRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Supabase request failed (${status}): ${body || "empty response"}`);
  }
}

export function createSupabaseConversationStateComponent(
  config: SupabaseConversationStateConfig,
): ChannelLifecycleComponent {
  return {
    name: "pancake-supabase-conversation-state",
    before: (context) => prepareConversationState(config, context),
    after: (context, result) => recordAgentReply(config, context, result),
  };
}

async function prepareConversationState(
  config: SupabaseConversationStateConfig,
  context: ChannelLifecycleContext,
): Promise<ChannelHookResult> {
  const source = pancakeSource(context.source);
  if (!source || !context.accountId || !context.agentId) {
    return {};
  }

  const providerCreatedAt = normalizeTimestamp(source.insertedAt);
  const messageTime = providerCreatedAt ?? new Date().toISOString();
  const state = await upsertConversationState(config, {
    conversationKey: context.conversationKey,
    accountId: context.accountId,
    agentId: context.agentId,
    channel: context.channelName,
    conversationId: source.conversationId,
    customerExternalId: source.pageCustomerId ?? source.fromId,
    lastCustomerMessageAt: messageTime,
  });
  const inserted = await insertConversationMessage(config, {
    conversationKey: context.conversationKey,
    accountId: context.accountId,
    agentId: context.agentId,
    channel: context.channelName,
    providerMessageId: source.messageId,
    senderType: "customer",
    senderId: source.pageCustomerId ?? source.fromId,
    senderName: source.fromName,
    body: extractText(context.content).trim(),
    metadata: sourceMetadata(source),
    rawPayload: source.rawPayload ?? context.source,
    providerCreatedAt,
  });

  if (!inserted) {
    logInfo("Duplicate Supabase conversation message skipped", {
      conversationKey: context.conversationKey,
      providerMessageId: source.messageId,
    });
    return { stop: true, reason: "duplicate_message" };
  }

  if (state.reply_mode !== "auto") {
    return { stop: true, reason: `reply_mode_${state.reply_mode}` };
  }

  return {
    ephemeralSystem: [{
      role: "system",
      content: formatConversationStatePrompt(state),
    } satisfies SystemModelMessage],
  };
}

async function recordAgentReply(
  config: SupabaseConversationStateConfig,
  context: ChannelLifecycleContext,
  result: ChannelReplyResult,
): Promise<void> {
  const source = pancakeSource(context.source);
  if (!source || !context.accountId || !context.agentId) {
    return;
  }

  const now = new Date().toISOString();
  await insertConversationMessage(config, {
    conversationKey: context.conversationKey,
    accountId: context.accountId,
    agentId: context.agentId,
    channel: context.channelName,
    providerMessageId: `agent:${context.eventId}`,
    senderType: "agent",
    senderId: context.agentId,
    senderName: "agent",
    body: result.text,
    metadata: sourceMetadata(source, { sourceEventId: context.eventId }),
    rawPayload: {
      sourceEventId: context.eventId,
      responseText: result.text,
    },
    providerCreatedAt: now,
  });
  await updateConversationStateTimestamps(config, context.conversationKey, {
    last_agent_reply_at: now,
    updated_at: now,
  });
}

async function upsertConversationState(
  config: SupabaseConversationStateConfig,
  input: {
    conversationKey: string;
    accountId: string;
    agentId: string;
    channel: string;
    conversationId: string;
    customerExternalId?: string;
    lastCustomerMessageAt: string;
  },
): Promise<ConversationStateRecord> {
  const now = new Date().toISOString();
  const [state] = await supabaseRequest<ConversationStateRecord[]>(
    config,
    `conversation_states?${new URLSearchParams({ on_conflict: "conversation_key", select: "*" })}`,
    {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        conversation_key: input.conversationKey,
        account_id: input.accountId,
        agent_id: input.agentId,
        channel: input.channel,
        provider_conversation_id: input.conversationId,
        ...(input.customerExternalId ? { customer_external_id: input.customerExternalId } : {}),
        last_customer_message_at: input.lastCustomerMessageAt,
        updated_at: now,
      }),
    },
  ) ?? [];

  if (!state) {
    throw new Error("Supabase conversation state upsert returned no row");
  }

  return state;
}

async function insertConversationMessage(
  config: SupabaseConversationStateConfig,
  input: {
    conversationKey: string;
    accountId: string;
    agentId: string;
    channel: string;
    providerMessageId: string;
    senderType: "customer" | "agent" | "human" | "system";
    senderId?: string;
    senderName?: string;
    body: string;
    metadata: JSONValue;
    rawPayload: unknown;
    providerCreatedAt?: string;
  },
): Promise<boolean> {
  try {
    await supabaseRequest(config, "conversation_messages", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        conversation_key: input.conversationKey,
        account_id: input.accountId,
        agent_id: input.agentId,
        channel: input.channel,
        provider_message_id: input.providerMessageId,
        sender_type: input.senderType,
        ...(input.senderId ? { sender_id: input.senderId } : {}),
        ...(input.senderName ? { sender_name: input.senderName } : {}),
        ...(input.body ? { body: input.body } : {}),
        metadata: input.metadata,
        raw_payload: toJsonPayload(input.rawPayload),
        ...(input.providerCreatedAt ? { provider_created_at: input.providerCreatedAt } : {}),
      }),
    });
    return true;
  } catch (err) {
    if (err instanceof SupabaseRequestError && err.status === 409) {
      return false;
    }
    throw err;
  }
}

async function updateConversationStateTimestamps(
  config: SupabaseConversationStateConfig,
  conversationKey: string,
  patch: Pick<ConversationStateRecord, "last_agent_reply_at" | "updated_at">,
): Promise<void> {
  const query = new URLSearchParams({ conversation_key: `eq.${conversationKey}` });
  await supabaseRequest(config, `conversation_states?${query}`, {
    method: "PATCH",
    headers: { "Prefer": "return=minimal" },
    body: JSON.stringify(patch),
  });
}

async function supabaseRequest<T>(
  config: SupabaseConversationStateConfig,
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
    throw new SupabaseRequestError(response.status, bodyText);
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

function formatConversationStatePrompt(state: ConversationStateRecord): string {
  const metadata = state.metadata ?? {};
  const metadataText = isEmptyObject(metadata) ? null : JSON.stringify(metadata, null, 2);
  const lines = [
    "Current customer-service conversation state:",
    `- reply_mode: ${state.reply_mode}`,
    metadataText ? "- metadata:" : null,
    metadataText,
    "",
    "Use this state as operational context. Do not reveal internal field names to the customer.",
  ].filter((line): line is string => line !== null);

  return lines.join("\n");
}

function pancakeSource(source: Record<string, unknown>): PancakeConversationSource | null {
  if (
    typeof source.pageId !== "string" ||
    typeof source.conversationId !== "string" ||
    typeof source.messageId !== "string"
  ) {
    return null;
  }

  return {
    pageId: source.pageId,
    conversationId: source.conversationId,
    messageId: source.messageId,
    fromId: typeof source.fromId === "string" ? source.fromId : undefined,
    fromName: typeof source.fromName === "string" ? source.fromName : undefined,
    pageCustomerId: typeof source.pageCustomerId === "string" ? source.pageCustomerId : undefined,
    insertedAt: typeof source.insertedAt === "string" ? source.insertedAt : undefined,
    rawPayload: source.rawPayload,
  };
}

function sourceMetadata(
  source: PancakeConversationSource,
  extra: { sourceEventId?: string } = {},
): JSONValue {
  return toJsonPayload({
    provider: {
      page_id: source.pageId,
      conversation_id: source.conversationId,
    },
    ...(source.fromName
      ? {
        customer: {
          name: source.fromName,
        },
      }
      : {}),
    ...(extra.sourceEventId ? { source_event_id: extra.sourceEventId } : {}),
  });
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    logWarn("Ignoring invalid provider timestamp", { value });
    return undefined;
  }

  return timestamp.toISOString();
}

function toJsonPayload(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch (err) {
    logError("Failed to serialize Supabase raw payload", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function isEmptyObject(value: JSONValue): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0,
  );
}
