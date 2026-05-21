/**
 * Pancake Supabase reply-mode component.
 * This only gates whether the agent should reply for a conversation.
 */

import type {
  ChannelLifecycleComponent,
  ChannelLifecycleContext,
  ChannelLifecycleResult,
} from "../../_shared/channels.ts";

const SUPABASE_REST_PATH = "rest/v1/";

type ReplyMode = "auto" | "human" | "paused";

export interface PancakeSupabaseReplyModeConfig {
  url: string;
  serviceRoleKey: string;
}

interface ConversationStateRecord {
  conversation_key: string;
  reply_mode: ReplyMode;
}

export function createPancakeSupabaseReplyModeComponent(
  config: PancakeSupabaseReplyModeConfig,
): ChannelLifecycleComponent {
  return {
    name: "pancake-supabase-reply-mode",
    before: (context) => checkReplyMode(config, context),
  };
}

async function checkReplyMode(
  config: PancakeSupabaseReplyModeConfig,
  context: ChannelLifecycleContext,
): Promise<ChannelLifecycleResult> {
  const state = await upsertConversationState(config, context.conversationKey);
  if (state.reply_mode === "auto") {
    return {};
  }

  return { stop: true, reason: `reply_mode_${state.reply_mode}` };
}

async function upsertConversationState(
  config: PancakeSupabaseReplyModeConfig,
  conversationKey: string,
): Promise<ConversationStateRecord> {
  const [state] = await supabaseRequest<ConversationStateRecord[]>(
    config,
    `conversation_states?${new URLSearchParams({ on_conflict: "conversation_key", select: "conversation_key,reply_mode" })}`,
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
  config: PancakeSupabaseReplyModeConfig,
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
