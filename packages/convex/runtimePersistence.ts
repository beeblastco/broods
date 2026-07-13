/**
 * Transactional persistence for the core runtime. These functions replace the
 * former Convex conversation, claim, async-result, and reservation tables.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  runtimeAsyncAgentResultsFields,
  runtimeAsyncToolResultsFields,
  sandboxProviderValidator,
} from "./schema";

const DAY_SECONDS = 24 * 60 * 60;
const CONVERSATION_EVENT_PAGE_SIZE = 512;

/**
 * Extracts the account ID from an account-scoped runtime key.
 * @param value account-scoped runtime key
 * @returns embedded account ID
 * @throws when the key has no valid account prefix
 */
function accountIdFromKey(value: string): string {
  const match = /^acct:([^:]+):/.exec(value);
  if (!match?.[1]) throw new Error("Runtime key is not account scoped");

  return match[1];
}

/**
 * Normalizes a claim key into its owning account namespace.
 * @param accountId owning account ID
 * @param key scoped or integration-provided claim key
 * @returns account-scoped claim key
 * @throws when an already-scoped key belongs to another account
 */
function claimKeyForAccount(accountId: string, key: string): string {
  if (!key.startsWith("acct:")) {

    return `acct:${accountId}:claim:${key}`;
  }
  if (accountIdFromKey(key) !== accountId) {
    throw new Error("Runtime claim key does not belong to accountId");
  }

  return key;
}

/**
 * Requires an account to exist and remain active in the runtime-write transaction.
 * @param ctx Convex mutation context
 * @param accountId account ID embedded in the runtime row or key
 * @throws when the account is missing, disabled, or malformed
 */
async function requireActiveAccount(
  ctx: MutationCtx,
  accountId: string,
): Promise<void> {
  const normalized = ctx.db.normalizeId("accounts", accountId);
  const account = normalized ? await ctx.db.get(normalized) : null;
  if (!account || account.status !== "active") {
    throw new Error(`Account is not active: ${accountId}`);
  }
}

const asyncAgentDoc = v.object({
  ...runtimeAsyncAgentResultsFields,
  _id: v.id("runtimeAsyncAgentResults"),
  _creationTime: v.number(),
});
const {
  completionTokenHash: _completionTokenHash,
  ...runtimeAsyncToolPublicFields
} = runtimeAsyncToolResultsFields;
const asyncToolDoc = v.object({
  ...runtimeAsyncToolPublicFields,
  _id: v.id("runtimeAsyncToolResults"),
  _creationTime: v.number(),
});

/** Removes callback authorization from general async-tool result reads. */
function hideCompletionTokenHash<T extends { completionTokenHash?: string }>(
  row: T,
): Omit<T, "completionTokenHash"> {
  const { completionTokenHash: _hidden, ...publicRow } = row;

  return publicRow;
}

/** Hashes a high-entropy callback token before persistence or comparison. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const toolGroupDoc = v.object({
  accountId: v.string(),
  parentEventId: v.string(),
  resultIds: v.array(v.string()),
  sealed: v.boolean(),
  expiresAt: v.number(),
  _id: v.id("runtimeAsyncToolGroups"),
  _creationTime: v.number(),
});

/**
 * Atomically claims a dedupe key until its expiry.
 * @returns whether this invocation acquired the claim
 */
export const claimEvent = internalMutation({
  args: {
    accountId: v.id("accounts"),
    key: v.string(),
    ttlSeconds: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireActiveAccount(ctx, args.accountId);
    const key = claimKeyForAccount(args.accountId, args.key);
    const existing = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing && existing.accountId !== args.accountId) {
      throw new Error("Runtime claim does not belong to accountId");
    }
    const now = Math.floor(Date.now() / 1000);
    if (existing && existing.expiresAt >= now) {

      return false;
    }
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("runtimeClaims", {
      accountId: args.accountId,
      key: key,
      kind: "event",
      expiresAt: now + args.ttlSeconds,
    });

    return true;
  },
});

/**
 * Releases an event claim when processing must be retried.
 * @returns null after the release attempt
 */
export const releaseClaim = internalMutation({
  args: { accountId: v.id("accounts"), key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireActiveAccount(ctx, args.accountId);
    const key = claimKeyForAccount(args.accountId, args.key);
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (row && row.accountId !== args.accountId) {
      throw new Error("Runtime claim does not belong to accountId");
    }
    if (row?.kind === "event") await ctx.db.delete(row._id);

    return null;
  },
});

/**
 * Acquires an expired or absent conversation lease transactionally.
 * @returns whether this invocation acquired the lease
 */
export const acquireLease = internalMutation({
  args: {
    key: v.string(),
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ttlSeconds: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.conversationKey);
    await requireActiveAccount(ctx, accountId);
    const existing = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const now = Math.floor(Date.now() / 1000);
    if (existing && existing.expiresAt >= now) {

      return false;
    }
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("runtimeClaims", {
      accountId: accountId,
      key: args.key,
      kind: "lease",
      ownerEventId: args.ownerEventId,
      conversationKey: args.conversationKey,
      expiresAt: now + args.ttlSeconds,
    });

    return true;
  },
});

/**
 * Releases a conversation lease only for its current owner.
 * @returns null after the release attempt
 */
export const releaseLease = internalMutation({
  args: { key: v.string(), ownerEventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const accountId = row?.accountId ?? (row?.conversationKey
      ? accountIdFromKey(row.conversationKey)
      : undefined);
    if (accountId) await requireActiveAccount(ctx, accountId);
    if (row?.kind === "lease" && row.ownerEventId === args.ownerEventId)
      await ctx.db.delete(row._id);

    return null;
  },
});

/**
 * Appends ingress events to a conversation's transactional pending buffer.
 * @returns null after the events are queued
 */
export const enqueueIngress = internalMutation({
  args: {
    key: v.string(),
    conversationKey: v.string(),
    events: v.array(v.any()),
    ttlSeconds: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.conversationKey);
    await requireActiveAccount(ctx, accountId);
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const patch = {
      queued: [...(row?.queued ?? []), ...args.events],
      expiresAt: Math.floor(Date.now() / 1000) + args.ttlSeconds,
    };
    if (row) await ctx.db.patch(row._id, patch);
    else
      await ctx.db.insert("runtimeClaims", {
        accountId: accountId,
        key: args.key,
        kind: "pendingIngress",
        conversationKey: args.conversationKey,
        ...patch,
      });

    return null;
  },
});

/**
 * Atomically drains and removes a pending ingress buffer.
 * @returns the queued ingress events, or an empty array when none exist
 */
export const takeIngress = internalMutation({
  args: { key: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!row || row.kind !== "pendingIngress") {

      return [];
    }
    const accountId = row.accountId ?? (row.conversationKey
      ? accountIdFromKey(row.conversationKey)
      : undefined);
    if (accountId) await requireActiveAccount(ctx, accountId);
    await ctx.db.delete(row._id);

    return row.queued ?? [];
  },
});

/**
 * Appends one ordered event to a runtime conversation.
 * @returns null after the event is persisted
 */
export const appendConversationEvent = internalMutation({
  args: { conversationKey: v.string(), cursor: v.string(), event: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.conversationKey);
    await requireActiveAccount(ctx, accountId);
    await ctx.db.insert("runtimeConversationEvents", {
      accountId: accountId,
      ...args,
    });

    return null;
  },
});

/**
 * Lists one bounded page of ordered conversation events after an optional cursor.
 * @returns page rows plus an exclusive cursor for the next page
 */
export const listConversationEvents = internalQuery({
  args: { conversationKey: v.string(), afterCursor: v.optional(v.string()) },
  returns: v.object({
    page: v.array(v.object({ cursor: v.string(), event: v.any() })),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const query = ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        args.afterCursor
          ? q
              .eq("conversationKey", args.conversationKey)
              .gt("cursor", args.afterCursor)
          : q.eq("conversationKey", args.conversationKey),
      );
    const rows = await query.take(CONVERSATION_EVENT_PAGE_SIZE + 1);
    const page = rows.slice(0, CONVERSATION_EVENT_PAGE_SIZE);
    const isDone = rows.length <= CONVERSATION_EVENT_PAGE_SIZE;

    return {
      page: page.map((row) => ({ cursor: row.cursor, event: row.event })),
      isDone: isDone,
      continueCursor: isDone ? null : (page.at(-1)?.cursor ?? null),
    };
  },
});

/**
 * Clears one bounded batch of conversation events for the reset command.
 * @returns the number of deleted events
 */
export const clearConversation = internalMutation({
  args: { conversationKey: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireActiveAccount(ctx, accountIdFromKey(args.conversationKey));
    const rows = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);

    return rows.length;
  },
});

/**
 * Creates an idempotent processing row for async agent polling.
 * @returns whether a new result row was created
 */
export const createAsyncAgentResult = internalMutation({
  args: { eventId: v.string(), conversationKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.conversationKey);
    await requireActiveAccount(ctx, accountId);
    const existing = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) {

      return false;
    }
    const now = new Date().toISOString();
    await ctx.db.insert("runtimeAsyncAgentResults", {
      accountId: accountId,
      ...args,
      status: "processing",
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });

    return true;
  },
});

/**
 * Looks up an async agent result by its globally scoped event ID.
 * @returns the result document or null when it does not exist
 */
export const getAsyncAgentResult = internalQuery({
  args: { eventId: v.string() },
  returns: v.union(asyncAgentDoc, v.null()),
  handler: async (ctx, args) =>
    await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique(),
});

/**
 * Applies an async agent status, approval, response, or error transition.
 * @returns null after the result is updated
 */
export const updateAsyncAgentResult = internalMutation({
  args: {
    eventId: v.string(),
    status: runtimeAsyncAgentResultsFields.status,
    response: v.optional(v.any()),
    error: v.optional(v.string()),
    approvals: v.optional(v.array(v.any())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (!row) throw new Error("Async agent result not found");
    await requireActiveAccount(ctx, row.accountId);
    await ctx.db.patch(row._id, {
      status: args.status,
      response: args.response,
      error: args.error,
      approvals: args.approvals,
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });

    return null;
  },
});

/**
 * Creates an async tool row and registers it in its fan-in group atomically.
 * @returns whether a new result row was created
 */
export const createAsyncToolResult = internalMutation({
  args: {
    resultId: v.string(),
    parentEventId: v.string(),
    conversationKey: v.string(),
    toolName: v.string(),
    toolCallId: v.string(),
    input: v.any(),
    delivery: v.optional(v.any()),
    completionToken: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.conversationKey);
    await requireActiveAccount(ctx, accountId);
    const existing = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (existing) {

      return false;
    }
    const group = args.delivery
      ? await ctx.db
          .query("runtimeAsyncToolGroups")
          .withIndex("by_parentEventId", (q) =>
            q.eq("parentEventId", args.parentEventId),
          )
          .unique()
      : null;
    if (group?.sealed) {
      throw new Error("Cannot register an async tool result in a sealed group");
    }
    const now = new Date().toISOString();
    const { completionToken, ...persistedArgs } = args;
    await ctx.db.insert("runtimeAsyncToolResults", {
      accountId: accountId,
      ...persistedArgs,
      ...(completionToken
        ? { completionTokenHash: await sha256Hex(completionToken) }
        : {}),
      status: "processing",
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });
    if (args.delivery) {
      if (group && !group.resultIds.includes(args.resultId))
        await ctx.db.patch(group._id, {
          resultIds: [...group.resultIds, args.resultId],
          expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
        });
      else if (!group)
        await ctx.db.insert("runtimeAsyncToolGroups", {
          accountId: accountId,
          parentEventId: args.parentEventId,
          resultIds: [args.resultId],
          sealed: false,
          expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
        });
    }

    return true;
  },
});

/**
 * Looks up an async tool result without exposing callback authorization.
 * @returns the public result document or null when it does not exist
 */
export const getAsyncToolResult = internalQuery({
  args: { resultId: v.string() },
  returns: v.union(asyncToolDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();

    return row ? hideCompletionTokenHash(row) : null;
  },
});
/**
 * Verifies a supplied callback token without returning persisted authorization.
 * @returns whether the supplied token matches the persisted digest
 */
export const getAsyncToolToken = internalQuery({
  args: { resultId: v.string(), completionToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (!row?.completionTokenHash) {

      return false;
    }

    return row.completionTokenHash === (await sha256Hex(args.completionToken));
  },
});
/**
 * Lists the bounded async tool siblings for one parent event.
 * @returns the public sibling result documents
 */
export const listAsyncToolResults = internalQuery({
  args: { parentEventId: v.string() },
  returns: v.array(asyncToolDoc),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("runtimeAsyncToolResults")
        .withIndex("by_parentEventId", (q) =>
          q.eq("parentEventId", args.parentEventId),
        )
        .take(1000)
    ).map(hideCompletionTokenHash),
});
/**
 * Looks up fan-in group registration and seal state for a parent event.
 * @returns the fan-in group or null when it does not exist
 */
export const getAsyncToolGroup = internalQuery({
  args: { parentEventId: v.string() },
  returns: v.union(toolGroupDoc, v.null()),
  handler: async (ctx, args) =>
    await ctx.db
      .query("runtimeAsyncToolGroups")
      .withIndex("by_parentEventId", (q) =>
        q.eq("parentEventId", args.parentEventId),
      )
      .unique(),
});
/**
 * Seals a fan-in group after every sibling has been registered.
 * @returns the sealed group or null when it does not exist
 */
export const sealAsyncToolGroup = internalMutation({
  args: { parentEventId: v.string() },
  returns: v.union(toolGroupDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeAsyncToolGroups")
      .withIndex("by_parentEventId", (q) =>
        q.eq("parentEventId", args.parentEventId),
      )
      .unique();
    if (!row) {

      return null;
    }
    await requireActiveAccount(ctx, row.accountId);
    await ctx.db.patch(row._id, { sealed: true });

    return { ...row, sealed: true };
  },
});

/**
 * Settles or observes an async tool row with optional processing-only CAS
 * semantics.
 * @returns the updated public row, or null when the conditional update is rejected
 */
export const updateAsyncToolResult = internalMutation({
  args: {
    resultId: v.string(),
    status: runtimeAsyncToolResultsFields.status,
    response: v.optional(v.any()),
    error: v.optional(v.string()),
    observed: v.optional(v.boolean()),
    onlyWhenProcessing: v.optional(v.boolean()),
  },
  returns: v.union(asyncToolDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (row) await requireActiveAccount(ctx, row.accountId);
    if (!row || (args.onlyWhenProcessing && row.status !== "processing")) {

      return null;
    }
    const patch = {
      status: args.status,
      response:
        args.observed !== undefined && args.response === undefined
          ? row.response
          : args.response,
      error:
        args.observed !== undefined && args.error === undefined
          ? row.error
          : args.error,
      observed: args.observed ?? row.observed,
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    };
    await ctx.db.patch(row._id, patch);

    return hideCompletionTokenHash({ ...row, ...patch });
  },
});

/**
 * Resolves the provider ID for a persistent sandbox reservation.
 * @returns the provider ID or null when the reservation is absent
 */
export const getSandboxReservation = internalQuery({
  args: { provider: sandboxProviderValidator, reservationKey: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("sandboxReservations")
        .withIndex("by_provider_and_reservationKey", (q) =>
          q
            .eq("provider", args.provider)
            .eq("reservationKey", args.reservationKey),
        )
        .unique()
    )?.externalId ?? null,
});
/**
 * Claims a new persistent sandbox reservation if it is still unmapped.
 * @returns whether the reservation was created
 */
export const claimSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    externalId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.reservationKey);
    await requireActiveAccount(ctx, accountId);
    const row = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (row) {

      return false;
    }
    await ctx.db.insert("sandboxReservations", {
      accountId: accountId,
      ...args,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY_SECONDS,
    });

    return true;
  },
});
/**
 * Refreshes or creates a persistent sandbox reservation mapping.
 * @returns null after the mapping is saved
 */
export const saveSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    externalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const accountId = accountIdFromKey(args.reservationKey);
    await requireActiveAccount(ctx, accountId);
    const row = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    const patch = {
      externalId: args.externalId,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY_SECONDS,
    };
    if (row) await ctx.db.patch(row._id, patch);
    else
      await ctx.db.insert("sandboxReservations", {
        accountId: accountId,
        ...args,
        ...patch,
      });

    return null;
  },
});
/**
 * Deletes a reservation when its optional expected provider ID still matches.
 * @returns null after the delete attempt
 */
export const deleteSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    expectedExternalId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireActiveAccount(ctx, accountIdFromKey(args.reservationKey));
    const row = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (
      row &&
      (!args.expectedExternalId || row.externalId === args.expectedExternalId)
    )
      await ctx.db.delete(row._id);

    return null;
  },
});

/**
 * Deletes one bounded batch of every runtime row owned by an account. This
 * cleanup path intentionally accepts disabled or already-removed accounts.
 * @returns per-table deletion counts and their total
 */
export const deleteAccountRuntimeData = internalMutation({
  args: { accountId: v.string() },
  returns: v.object({
    conversationsDeleted: v.number(),
    processedEventsDeleted: v.number(),
    asyncAgentResultDeleted: v.number(),
    asyncToolResultDeleted: v.number(),
    asyncToolGroupDeleted: v.number(),
    sandboxReservationDeleted: v.number(),
    totalDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    const conversationRows = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const claimRows = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const agentRows = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const toolRows = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const groupRows = await ctx.db
      .query("runtimeAsyncToolGroups")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const reservationRows = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    for (const row of [
      ...conversationRows,
      ...claimRows,
      ...agentRows,
      ...toolRows,
      ...groupRows,
      ...reservationRows,
    ])
      await ctx.db.delete(row._id);

    return {
      conversationsDeleted: conversationRows.length,
      processedEventsDeleted: claimRows.length,
      asyncAgentResultDeleted: agentRows.length,
      asyncToolResultDeleted: toolRows.length,
      asyncToolGroupDeleted: groupRows.length,
      sandboxReservationDeleted: reservationRows.length,
      totalDeleted:
        conversationRows.length +
        claimRows.length +
        agentRows.length +
        toolRows.length +
        groupRows.length +
        reservationRows.length,
    };
  },
});

/**
 * Deletes expired operational rows in bounded batches and schedules
 * continuation when needed. This maintenance path intentionally bypasses the
 * active-account guard.
 * @returns the number of rows deleted in this batch
 */
export const pruneExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    const agentResults = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    const toolResults = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    const groups = await ctx.db
      .query("runtimeAsyncToolGroups")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    const reservations = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    const rows = [
      ...claims,
      ...agentResults,
      ...toolResults,
      ...groups,
      ...reservations,
    ];
    for (const row of rows) await ctx.db.delete(row._id);
    if (
      [claims, agentResults, toolResults, groups, reservations].some(
        (batch) => batch.length === 100,
      )
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.runtimePersistence.pruneExpired,
        {},
      );
    }

    return rows.length;
  },
});
