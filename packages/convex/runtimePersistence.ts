/**
 * Transactional persistence for the core runtime. These functions replace the
 * former Convex conversation, claim, async-result, and reservation tables.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  runtimeAsyncAgentResultsFields,
  runtimeAsyncToolResultsFields,
  sandboxProviderValidator,
} from "./schema";

const DAY_SECONDS = 24 * 60 * 60;

function accountIdFromKey(value: string): string {
  const match = /^acct:([^:]+):/.exec(value);
  if (!match?.[1]) throw new Error("Runtime key is not account scoped");
  return match[1];
}

const asyncAgentDoc = v.object({
  ...runtimeAsyncAgentResultsFields,
  _id: v.id("runtimeAsyncAgentResults"),
  _creationTime: v.number(),
});
const { completionToken: _completionToken, ...runtimeAsyncToolPublicFields } = runtimeAsyncToolResultsFields;
const asyncToolDoc = v.object({
  ...runtimeAsyncToolPublicFields,
  _id: v.id("runtimeAsyncToolResults"),
  _creationTime: v.number(),
});

/** Removes callback authorization from general async-tool result reads. */
function hideCompletionToken<T extends { completionToken?: string }>(row: T): Omit<T, "completionToken"> {
  const { completionToken: _hidden, ...publicRow } = row;
  return publicRow;
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

/** Atomically claims a dedupe key until its expiry. */
export const claimEvent = internalMutation({
  args: { key: v.string(), ttlSeconds: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const now = Math.floor(Date.now() / 1000);
    if (existing && existing.expiresAt >= now) return false;
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("runtimeClaims", {
      accountId: args.key.startsWith("acct:")
        ? accountIdFromKey(args.key)
        : undefined,
      key: args.key,
      kind: "event",
      expiresAt: now + args.ttlSeconds,
    });
    return true;
  },
});

/** Releases an event claim when processing must be retried. */
export const releaseClaim = internalMutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (row?.kind === "event") await ctx.db.delete(row._id);
    return null;
  },
});

/** Acquires an expired or absent conversation lease transactionally. */
export const acquireLease = internalMutation({
  args: {
    key: v.string(),
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ttlSeconds: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    const now = Math.floor(Date.now() / 1000);
    if (existing && existing.expiresAt >= now) return false;
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("runtimeClaims", {
      accountId: accountIdFromKey(args.conversationKey),
      key: args.key,
      kind: "lease",
      ownerEventId: args.ownerEventId,
      conversationKey: args.conversationKey,
      expiresAt: now + args.ttlSeconds,
    });
    return true;
  },
});

/** Releases a conversation lease only for its current owner. */
export const releaseLease = internalMutation({
  args: { key: v.string(), ownerEventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (row?.kind === "lease" && row.ownerEventId === args.ownerEventId)
      await ctx.db.delete(row._id);
    return null;
  },
});

/** Appends ingress events to a conversation's transactional pending buffer. */
export const enqueueIngress = internalMutation({
  args: {
    key: v.string(),
    conversationKey: v.string(),
    events: v.array(v.any()),
    ttlSeconds: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
        accountId: accountIdFromKey(args.conversationKey),
        key: args.key,
        kind: "pendingIngress",
        conversationKey: args.conversationKey,
        ...patch,
      });
    return null;
  },
});

/** Atomically drains and removes a pending ingress buffer. */
export const takeIngress = internalMutation({
  args: { key: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeClaims")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!row || row.kind !== "pendingIngress") return [];
    await ctx.db.delete(row._id);
    return row.queued ?? [];
  },
});

/** Appends one ordered event to a runtime conversation. */
export const appendConversationEvent = internalMutation({
  args: { conversationKey: v.string(), cursor: v.string(), event: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("runtimeConversationEvents", {
      accountId: accountIdFromKey(args.conversationKey),
      ...args,
    });
    return null;
  },
});

/** Lists ordered conversation events after an optional cursor. */
export const listConversationEvents = internalQuery({
  args: { conversationKey: v.string(), afterCursor: v.optional(v.string()) },
  returns: v.array(v.object({ cursor: v.string(), event: v.any() })),
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
    const rows = await query.take(8192);
    return rows.map((row) => ({ cursor: row.cursor, event: row.event }));
  },
});

/** Clears one bounded batch of conversation events for the reset command. */
export const clearConversation = internalMutation({
  args: { conversationKey: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
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

/** Creates an idempotent processing row for async agent polling. */
export const createAsyncAgentResult = internalMutation({
  args: { eventId: v.string(), conversationKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) return false;
    const now = new Date().toISOString();
    await ctx.db.insert("runtimeAsyncAgentResults", {
      accountId: accountIdFromKey(args.conversationKey),
      ...args,
      status: "processing",
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });
    return true;
  },
});

/** Returns an async agent result by its globally scoped event id. */
export const getAsyncAgentResult = internalQuery({
  args: { eventId: v.string() },
  returns: v.union(asyncAgentDoc, v.null()),
  handler: async (ctx, args) =>
    await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique(),
});

/** Applies an async agent status, approval, response, or error transition. */
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

/** Creates an async tool row and registers it in its fan-in group atomically. */
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
    const existing = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (existing) return false;
    const now = new Date().toISOString();
    await ctx.db.insert("runtimeAsyncToolResults", {
      accountId: accountIdFromKey(args.conversationKey),
      ...args,
      status: "processing",
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });
    if (args.delivery) {
      const group = await ctx.db
        .query("runtimeAsyncToolGroups")
        .withIndex("by_parentEventId", (q) =>
          q.eq("parentEventId", args.parentEventId),
        )
        .unique();
      if (group && !group.resultIds.includes(args.resultId))
        await ctx.db.patch(group._id, {
          resultIds: [...group.resultIds, args.resultId],
        });
      else if (!group)
        await ctx.db.insert("runtimeAsyncToolGroups", {
          accountId: accountIdFromKey(args.conversationKey),
          parentEventId: args.parentEventId,
          resultIds: [args.resultId],
          sealed: false,
          expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
        });
    }
    return true;
  },
});

/** Returns an async tool result without exposing its callback token separately. */
export const getAsyncToolResult = internalQuery({
  args: { resultId: v.string() },
  returns: v.union(asyncToolDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    return row ? hideCompletionToken(row) : null;
  },
});
/** Returns the isolated callback token for one async tool result. */
export const getAsyncToolToken = internalQuery({
  args: { resultId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("runtimeAsyncToolResults")
        .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
        .unique()
    )?.completionToken ?? null,
});
/** Lists the bounded async tool siblings for one parent event. */
export const listAsyncToolResults = internalQuery({
  args: { parentEventId: v.string() },
  returns: v.array(asyncToolDoc),
  handler: async (ctx, args) =>
    (await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_parentEventId", (q) =>
        q.eq("parentEventId", args.parentEventId),
      )
      .take(1000)).map(hideCompletionToken),
});
/** Returns fan-in group registration and seal state for a parent event. */
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
/** Seals a fan-in group after every sibling has been registered. */
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
    if (!row) return null;
    await ctx.db.patch(row._id, { sealed: true });
    return { ...row, sealed: true };
  },
});

/** Settles or observes an async tool row with optional processing-only CAS semantics. */
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
    if (!row || (args.onlyWhenProcessing && row.status !== "processing"))
      return null;
    const patch = {
      status: args.status,
      response: args.observed !== undefined && args.response === undefined ? row.response : args.response,
      error: args.observed !== undefined && args.error === undefined ? row.error : args.error,
      observed: args.observed ?? row.observed,
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    };
    await ctx.db.patch(row._id, patch);
    return hideCompletionToken({ ...row, ...patch });
  },
});

/** Resolves the provider id for a persistent sandbox reservation. */
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
/** Claims a new persistent sandbox reservation if it is still unmapped. */
export const claimSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    externalId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (row) return false;
    await ctx.db.insert("sandboxReservations", {
      accountId: accountIdFromKey(args.reservationKey),
      ...args,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY_SECONDS,
    });
    return true;
  },
});
/** Refreshes or creates a persistent sandbox reservation mapping. */
export const saveSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    externalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
        accountId: accountIdFromKey(args.reservationKey),
        ...args,
        ...patch,
      });
    return null;
  },
});
/** Deletes a reservation when its optional expected provider id still matches. */
export const deleteSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    expectedExternalId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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

/** Deletes one bounded batch of every runtime row owned by an account. */
export const deleteAccountRuntimeData = internalMutation({
  args: { accountId: v.string() },
  returns: v.object({
    conversationsDeleted: v.number(),
    processedEventsDeleted: v.number(),
    asyncAgentResultDeleted: v.number(),
    asyncToolResultDeleted: v.number(),
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
      totalDeleted: conversationRows.length + claimRows.length + agentRows.length + toolRows.length + groupRows.length + reservationRows.length,
    };
  },
});

/** Deletes expired operational rows in bounded batches and continues until caught up. */
export const pruneExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = await ctx.db.query("runtimeClaims").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(100);
    const agentResults = await ctx.db.query("runtimeAsyncAgentResults").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(100);
    const toolResults = await ctx.db.query("runtimeAsyncToolResults").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(100);
    const groups = await ctx.db.query("runtimeAsyncToolGroups").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(100);
    const reservations = await ctx.db.query("sandboxReservations").withIndex("by_expiresAt", q => q.lt("expiresAt", now)).take(100);
    const rows = [...claims, ...agentResults, ...toolResults, ...groups, ...reservations];
    for (const row of rows) await ctx.db.delete(row._id);
    if ([claims, agentResults, toolResults, groups, reservations].some(batch => batch.length === 100)) {
      await ctx.scheduler.runAfter(0, internal.runtimePersistence.pruneExpired, {});
    }
    return rows.length;
  },
});
