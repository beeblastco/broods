/**
 * Dashboard-facing conversation history over the runtime's own transcript
 * store. The runtime persists every turn to `runtimeConversationEvents`,
 * keyed `acct:{accountId}:agent:{agentId}:api:{publicConversationKey}` with a
 * sortable `{ISO time}#{eventId}#{seq}` cursor (see apps/core
 * harness/session.ts). The product `conversations` table has no runtime
 * writer; rows there only annotate a runtime key with user-facing metadata
 * (title). This module derives the conversation list and transcripts from the
 * runtime rows, so the dashboard shows the history that actually exists.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accountIdForProject } from "./auditEvents";
import { getOwnedProject } from "./ownership/project";

/** Everything needed to address one agent's runtime conversations. */
export interface AgentConversationScope {
  accountId: Id<"accounts">;
  agentId: Id<"agents">;
  /** Scoped-key prefix of the agent's direct-API (Test chat) conversations. */
  keyPrefix: string;
}

/** Upper bound on distinct conversations enumerated per list call. */
export const MAX_ENUMERATED_CONVERSATIONS = 200;
/** Conversations returned per list call, newest activity first. */
export const CONVERSATION_LIST_LIMIT = 50;
/** Transcript events returned per page. */
export const MESSAGE_PAGE_SIZE = 100;
/** Runtime event rows deleted per delete call; callers loop on hasMore. */
export const DELETE_BATCH_SIZE = 200;
/** Derived-title length cap, matching how the list renders. */
const TITLE_MAX_CHARS = 60;
/** Explicit (renamed) title length cap. */
export const TITLE_LIMIT = 120;

/**
 * Resolve an agent config to the account/agent scope the caller may read,
 * or null when the config, its project ownership, its live agent row, or the
 * project's account is missing. `authId` must come from the authenticated
 * user — this is the ownership boundary for every public function above it.
 */
export async function resolveAgentConversationScope(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  configId: Id<"agentConfigs">,
): Promise<AgentConversationScope | null> {
  const config = await ctx.db.get(configId);
  if (!config) return null;
  const project = await getOwnedProject(ctx, authId, config.projectId);
  if (!project) return null;
  if (!config.agentId) return null;
  const accountId = await accountIdForProject(ctx, config.projectId);
  if (!accountId) return null;
  // The config stores the agents-row id as a plain string; verify it is a
  // real agent row of this account before deriving a key prefix from it.
  const agent = await ctx.db.normalizeId("agents", config.agentId);
  if (!agent) return null;
  const agentDoc = await ctx.db.get(agent);
  if (!agentDoc || agentDoc.accountId !== accountId) return null;

  return {
    accountId: accountId,
    agentId: agent,
    keyPrefix: `acct:${accountId}:agent:${agent}:api:`,
  };
}

/** One conversation in the list, addressed by its public key. */
export interface ConversationSummary {
  conversationKey: string;
  /** Explicit title if renamed, else derived from the first user message. */
  title: string;
  createdAt: number;
  lastMessageAt: number;
}

/** Timestamp embedded in a runtime event cursor (`{ISO}#{eventId}#{seq}`). */
function cursorTimestamp(cursor: string): number {
  const separator = cursor.indexOf("#");
  const parsed = Date.parse(
    separator > 0 ? cursor.slice(0, separator) : cursor,
  );

  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The persisted stored-event envelope (see harness/session.ts). */
interface StoredEventEnvelope {
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** First text found in a stored user message, for derived titles. */
function userMessageText(event: unknown): string | null {
  const message = (event as StoredEventEnvelope | null)?.message;
  if (!message || message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const candidate = part as { type?: string; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }
    }
  }

  return null;
}

function deriveTitle(text: string | null): string {
  const trimmed = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed) return "Untitled";

  return trimmed.length > TITLE_MAX_CHARS
    ? `${trimmed.slice(0, TITLE_MAX_CHARS - 1)}…`
    : trimmed;
}

/**
 * Enumerate the distinct scoped conversation keys under a prefix, oldest key
 * first (index order), bounded by MAX_ENUMERATED_CONVERSATIONS. Distinctness
 * comes from successive index seeks (`> last key`), so cost is one read per
 * conversation, not per event.
 */
async function enumerateConversationKeys(
  ctx: QueryCtx | MutationCtx,
  keyPrefix: string,
): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  let lastKey: string | null = null;
  while (keys.length < MAX_ENUMERATED_CONVERSATIONS) {
    const previous: string | null = lastKey;
    const row = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        previous === null
          ? q.gte("conversationKey", keyPrefix)
          : q.gt("conversationKey", previous),
      )
      .first();
    if (!row || !row.conversationKey.startsWith(keyPrefix)) {
      return { keys: keys, truncated: false };
    }
    keys.push(row.conversationKey);
    lastKey = row.conversationKey;
  }

  return { keys: keys, truncated: true };
}

/**
 * Build the conversation list for one agent: newest activity first, capped at
 * CONVERSATION_LIST_LIMIT. Titles come from the `conversations` annotation
 * row when present, else are derived from the first user message so the list
 * never renders a wall of "Untitled".
 */
export async function listAgentConversations(
  ctx: QueryCtx | MutationCtx,
  scope: AgentConversationScope,
): Promise<{ conversations: ConversationSummary[]; truncated: boolean }> {
  const { keys, truncated } = await enumerateConversationKeys(
    ctx,
    scope.keyPrefix,
  );

  const summaries: ConversationSummary[] = [];
  for (const key of keys) {
    const [firstRows, lastRow, annotation] = await Promise.all([
      ctx.db
        .query("runtimeConversationEvents")
        .withIndex("by_conversationKey_and_cursor", (q) =>
          q.eq("conversationKey", key),
        )
        .take(4),
      ctx.db
        .query("runtimeConversationEvents")
        .withIndex("by_conversationKey_and_cursor", (q) =>
          q.eq("conversationKey", key),
        )
        .order("desc")
        .first(),
      conversationAnnotation(ctx, scope, key),
    ]);
    const firstRow = firstRows[0];
    if (!firstRow || !lastRow) continue;
    const firstUserText =
      firstRows.map((row) => userMessageText(row.event)).find(Boolean) ?? null;
    summaries.push({
      conversationKey: key.slice(scope.keyPrefix.length),
      title: annotation?.title ?? deriveTitle(firstUserText),
      createdAt: cursorTimestamp(firstRow.cursor),
      lastMessageAt: cursorTimestamp(lastRow.cursor),
    });
  }

  summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return {
    conversations: summaries.slice(0, CONVERSATION_LIST_LIMIT),
    truncated: truncated || summaries.length > CONVERSATION_LIST_LIMIT,
  };
}

/** Scoped key for one of the agent's public conversation keys. */
export function scopedKey(
  scope: AgentConversationScope,
  publicConversationKey: string,
): string {
  return `${scope.keyPrefix}${publicConversationKey}`;
}

/** The title-annotation row for a scoped key, if the account owns it. */
async function conversationAnnotation(
  ctx: QueryCtx | MutationCtx,
  scope: AgentConversationScope,
  scopedConversationKey: string,
): Promise<Doc<"conversations"> | null> {
  const row = await ctx.db
    .query("conversations")
    .withIndex("by_conversationKey", (q) =>
      q.eq("conversationKey", scopedConversationKey),
    )
    .unique();

  return row && row.accountId === scope.accountId ? row : null;
}

/** One page of a conversation's transcript, oldest first. */
export async function listConversationMessages(
  ctx: QueryCtx | MutationCtx,
  scope: AgentConversationScope,
  publicConversationKey: string,
  afterCursor?: string,
): Promise<{
  page: Array<{ cursor: string; event: unknown }>;
  isDone: boolean;
  continueCursor: string | null;
}> {
  const key = scopedKey(scope, publicConversationKey);
  const rows = await ctx.db
    .query("runtimeConversationEvents")
    .withIndex("by_conversationKey_and_cursor", (q) =>
      afterCursor
        ? q.eq("conversationKey", key).gt("cursor", afterCursor)
        : q.eq("conversationKey", key),
    )
    .take(MESSAGE_PAGE_SIZE + 1);
  const page = rows.slice(0, MESSAGE_PAGE_SIZE);
  const isDone = rows.length <= MESSAGE_PAGE_SIZE;

  return {
    page: page.map((row) => ({ cursor: row.cursor, event: row.event })),
    isDone: isDone,
    continueCursor: isDone ? null : (page.at(-1)?.cursor ?? null),
  };
}

/** Upsert the title annotation for one conversation the account owns. */
export async function renameAgentConversation(
  ctx: MutationCtx,
  scope: AgentConversationScope,
  publicConversationKey: string,
  title: string,
): Promise<void> {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("Title must not be empty");
  if (trimmed.length > TITLE_LIMIT) {
    throw new Error(`Title must be at most ${TITLE_LIMIT} characters`);
  }
  const key = scopedKey(scope, publicConversationKey);
  const firstRow = await ctx.db
    .query("runtimeConversationEvents")
    .withIndex("by_conversationKey_and_cursor", (q) =>
      q.eq("conversationKey", key),
    )
    .first();
  if (!firstRow) throw new Error("Conversation not found");

  const existing = await conversationAnnotation(ctx, scope, key);
  if (existing) {
    await ctx.db.patch(existing._id, { title: trimmed });

    return;
  }
  const lastRow = await ctx.db
    .query("runtimeConversationEvents")
    .withIndex("by_conversationKey_and_cursor", (q) =>
      q.eq("conversationKey", key),
    )
    .order("desc")
    .first();
  await ctx.db.insert("conversations", {
    accountId: scope.accountId,
    agentId: scope.agentId,
    title: trimmed,
    createdAt: cursorTimestamp(firstRow.cursor),
    lastMessageAt: cursorTimestamp(lastRow?.cursor ?? firstRow.cursor),
    conversationKey: key,
  });
}

/**
 * Delete one batch of a conversation's runtime rows. On the final batch also
 * removes the harness resume checkpoint and the title annotation. Callers
 * loop while `hasMore` — mirrors internal.runtime.clearConversation.
 */
export async function deleteAgentConversation(
  ctx: MutationCtx,
  scope: AgentConversationScope,
  publicConversationKey: string,
): Promise<{ deleted: number; hasMore: boolean }> {
  const key = scopedKey(scope, publicConversationKey);
  const rows = await ctx.db
    .query("runtimeConversationEvents")
    .withIndex("by_conversationKey_and_cursor", (q) =>
      q.eq("conversationKey", key),
    )
    .take(DELETE_BATCH_SIZE + 1);
  const batch = rows.slice(0, DELETE_BATCH_SIZE);
  for (const row of batch) await ctx.db.delete(row._id);
  const hasMore = rows.length > DELETE_BATCH_SIZE;

  if (!hasMore) {
    const harnessSession = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_conversationKey", (q) => q.eq("conversationKey", key))
      .unique();
    if (harnessSession) await ctx.db.delete(harnessSession._id);
    const annotation = await conversationAnnotation(ctx, scope, key);
    if (annotation) await ctx.db.delete(annotation._id);
  }

  return { deleted: batch.length, hasMore: hasMore };
}
