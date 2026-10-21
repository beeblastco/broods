/**
 * Transactional persistence for the core runtime.
 */

import { getConvexSize, type Infer, v, type Value } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sha256Hex } from "./model/accountSecrets";
import {
  reservedSandboxValidator,
  runtimeAsyncAgentResultsFields,
  runtimeAsyncToolResultsFields,
  runtimeConversationEventsFields,
  sandboxProviderValidator,
  sandboxSnapshotScopeValidator,
  subagentTaskValidator,
} from "./schema";
import {
  accountIdFromKey,
  requireActiveAccount,
  requireActiveKeyAccount,
} from "./model/activeAccount";
import {
  handbackMoveValidator,
  parseHandbackDedupeKey,
  sweptHandbackValidator,
} from "./model/subagentResults";

const CONVERSATION_CLEAR_BATCH_SIZE = 100;
// Bytes and not rows bound a page: the per-query read limit counts bytes, and
// one tool result can weigh as much as a thousand text rows.
const CONVERSATION_EVENT_PAGE_BYTES = 4 * 1_024 * 1_024;
const CONVERSATION_EVENT_PAGE_SIZE = 512;
const DAY_SECONDS = 24 * 60 * 60;
// The most queued envelopes a conversation holds (core's
// `DEFAULT_INGRESS_MAX_COUNT`), all read to find a queued resume.
const QUEUED_RESUME_SCAN = 100;
// One recovery sweep's page of late subagent or async tool results.
const OWED_RESULT_PAGE_SIZE = 100;

const REPLACED_SANDBOX_ERROR =
  "Background job ran on a sandbox that has since been replaced";

const RUNTIME_DELETE_BATCH_SIZE = 100;

// Idle window a reservation survives, refreshed on every acquire. Only core's sandbox
// sweeper may act on it: the row holds the sole copy of `externalId`, so deleting it
// without deleting the sandbox first strands the machine.
export const SANDBOX_RESERVATION_TTL_SECONDS = 7 * DAY_SECONDS;

/** A whole step's history rows in one write, in cursor order. */
export const conversationEventsValidator = v.array(
  v.object({
    cursor: v.string(),
    dedupeKey: runtimeConversationEventsFields.dedupeKey,
    event: v.any(),
  }),
);

/** How an async run ended, or what it waits on, as its polling row records it. */
export const asyncAgentOutcomeValidator = v.object({
  status: runtimeAsyncAgentResultsFields.status,
  response: v.optional(v.any()),
  error: v.optional(v.string()),
  approvals: v.optional(v.array(v.any())),
  questions: v.optional(v.array(v.any())),
});

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

const sandboxReservationSummary = v.object({
  ...reservedSandboxValidator.fields,
  accountId: v.id("accounts"),
  ttlSeconds: v.optional(v.number()),
});

const sandboxReleaseTarget = v.object({
  externalId: v.union(v.string(), v.null()),
  instance: v.union(
    v.object({
      ownCredentials: v.boolean(),
      sandboxConfigId: v.optional(v.id("sandboxConfigs")),
    }),
    v.null(),
  ),
});

interface SandboxReservationPage {
  page: Infer<typeof sandboxReservationSummary>[];
  cursor: string | null;
  isDone: boolean;
}

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
  handler: async (ctx, args): Promise<boolean> => {
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
  handler: async (ctx, args): Promise<null> => {
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
 * @returns null after the events are persisted
 */
export const appendConversationEvent = internalMutation({
  args: { conversationKey: v.string(), events: conversationEventsValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const accountId = await requireActiveKeyAccount(ctx, args.conversationKey);
    await insertConversationEvents(
      ctx,
      accountId,
      args.conversationKey,
      args.events,
    );

    return null;
  },
});

/**
 * Inserts history rows in order. A row whose dedupe key this conversation
 * already stores is skipped: its first append committed and only the reply
 * was lost, so the retry must not store it again. A row keyed as a subagent
 * or async tool result marks that result's hand-back stored in the transaction
 * that inserts it, so the row and the flag can never disagree.
 */
export async function insertConversationEvents(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  conversationKey: string,
  events: Infer<typeof conversationEventsValidator>,
): Promise<void> {
  for (const entry of events) {
    if (
      entry.dedupeKey !== undefined &&
      (await ctx.db
        .query("runtimeConversationEvents")
        .withIndex("by_conversationKey_and_dedupeKey", (q) =>
          q
            .eq("conversationKey", conversationKey)
            .eq("dedupeKey", entry.dedupeKey),
        )
        .first())
    ) {
      continue;
    }
    await ctx.db.insert("runtimeConversationEvents", {
      ...entry,
      accountId: accountId,
      conversationKey: conversationKey,
    });
    const handback =
      entry.dedupeKey === undefined
        ? undefined
        : parseHandbackDedupeKey(entry.dedupeKey);
    if (handback?.kind === "subagent") {
      await markResultStored(
        ctx,
        accountId,
        await asyncAgentResultRow(ctx, handback.eventId),
      );
    } else if (handback?.kind === "async-tool") {
      await markResultStored(
        ctx,
        accountId,
        await asyncToolResultRow(ctx, handback.resultId),
      );
    }
  }
}

/**
 * Forward from `afterCursor` by default. With `fromSystemPrefix`, it pages
 * backward instead, newest first from `beforeCursor`, and is done at the
 * latest system row whose text starts with that prefix (core's compaction
 * summary) or at the first row: a turn reads only the rows it projects. Each
 * page is in cursor order; `continueCursor` is the next `beforeCursor` then.
 * @returns page rows plus an exclusive cursor for the next page
 */
export const listConversationEvents = internalQuery({
  args: {
    conversationKey: v.string(),
    afterCursor: v.optional(v.string()),
    beforeCursor: v.optional(v.string()),
    fromSystemPrefix: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(v.object({ cursor: v.string(), event: v.any() })),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    if (args.fromSystemPrefix !== undefined) {
      const prefix = args.fromSystemPrefix;
      const newest: { cursor: string; event: Value }[] = [];
      let newestBytes = 0;
      let isDone = true;
      for await (const row of ctx.db
        .query("runtimeConversationEvents")
        .withIndex("by_conversationKey_and_cursor", (q) =>
          args.beforeCursor
            ? q
                .eq("conversationKey", args.conversationKey)
                .lt("cursor", args.beforeCursor)
            : q.eq("conversationKey", args.conversationKey),
        )
        .order("desc")) {
        if (
          newest.length >= CONVERSATION_EVENT_PAGE_SIZE ||
          newestBytes >= CONVERSATION_EVENT_PAGE_BYTES
        ) {
          isDone = false;
          break;
        }
        newest.push({ cursor: row.cursor, event: row.event });
        newestBytes += getConvexSize(row.event);
        if (isSystemTextWithPrefix(row.event, prefix)) break;
      }

      return {
        page: newest.reverse(),
        isDone: isDone,
        continueCursor: isDone ? null : (newest[0]?.cursor ?? null),
      };
    }
    const query = ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        args.afterCursor
          ? q
              .eq("conversationKey", args.conversationKey)
              .gt("cursor", args.afterCursor)
          : q.eq("conversationKey", args.conversationKey),
      );
    const page: { cursor: string; event: Value }[] = [];
    let pageBytes = 0;
    let isDone = true;
    for await (const row of query) {
      // The first row always lands, so a page is never empty and the cursor
      // always moves, even past one row larger than the budget.
      if (
        page.length >= CONVERSATION_EVENT_PAGE_SIZE ||
        pageBytes >= CONVERSATION_EVENT_PAGE_BYTES
      ) {
        isDone = false;
        break;
      }
      page.push({ cursor: row.cursor, event: row.event });
      pageBytes += getConvexSize(row.event);
    }

    return {
      page: page,
      isDone: isDone,
      continueCursor: isDone ? null : (page.at(-1)?.cursor ?? null),
    };
  },
});

/** Whether a stored event is a system message whose text starts with `prefix`. */
function isSystemTextWithPrefix(event: unknown, prefix: string): boolean {
  if (typeof event !== "object" || event === null || !("message" in event)) {
    return false;
  }
  const message = event.message;

  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "system" &&
    "content" in message &&
    typeof message.content === "string" &&
    message.content.startsWith(prefix)
  );
}

export const getHarnessSession = internalQuery({
  args: { conversationKey: v.string() },
  returns: v.union(
    v.object({
      harnessType: v.union(
        v.literal("claude-code"),
        v.literal("codex"),
        v.literal("deepagents"),
        v.literal("opencode"),
        v.literal("pi"),
      ),
      sessionId: v.string(),
      resumeState: v.any(),
      reservationKey: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_conversationKey", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .unique();
    if (!row) {
      return null;
    }
    if (row.accountId !== accountIdFromKey(args.conversationKey)) {
      throw new Error(
        "Harness session does not belong to conversation account",
      );
    }

    return {
      harnessType: row.harnessType,
      sessionId: row.sessionId,
      resumeState: row.resumeState,
      reservationKey: row.reservationKey,
    };
  },
});

/**
 * Clears one bounded batch of conversation events for the reset command.
 * @returns the deleted event count and whether more events remain
 */
export const clearConversation = internalMutation({
  args: { conversationKey: v.string() },
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: number; hasMore: boolean }> => {
    await requireActiveKeyAccount(ctx, args.conversationKey);
    const rows = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .take(CONVERSATION_CLEAR_BATCH_SIZE + 1);
    const batch = rows.slice(0, CONVERSATION_CLEAR_BATCH_SIZE);
    for (const row of batch) await ctx.db.delete(row._id);
    const harnessSession = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_conversationKey", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .unique();
    if (harnessSession) await ctx.db.delete(harnessSession._id);

    return {
      deleted: batch.length,
      hasMore: rows.length > CONVERSATION_CLEAR_BATCH_SIZE,
    };
  },
});

/**
 * Creates an idempotent processing row for async agent polling. A subagent's
 * row starts its hand-back `pending`: the parent owes the result its write
 * from the start, so a child whose parent and pod die before any detach is
 * the recovery sweep's once no live run can hold it, not unseen for 7 days.
 * @returns whether a new result row was created
 */
export const createAsyncAgentResult = internalMutation({
  args: {
    eventId: v.string(),
    conversationKey: v.string(),
    subagent: v.optional(subagentTaskValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const accountId = await requireActiveKeyAccount(ctx, args.conversationKey);
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
      ...(args.subagent ? { handback: "pending" as const } : {}),
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
  handler: async (ctx, args): Promise<Doc<"runtimeAsyncAgentResults"> | null> =>
    await asyncAgentResultRow(ctx, args.eventId),
});

/**
 * One page of subagent results in `status` whose hand-back is `handback`
 * (`pending` or `detached`), written inside the window, oldest first. Core's
 * recovery sweep resumes their parents, walking every page each pass so rows
 * it must retry never crowd others out. A row of an inactive account is left
 * out: no resume of it can be admitted.
 * @returns the page and the cursor for the next one
 */
export const listOwedAsyncAgentResults = internalQuery({
  args: {
    handback: sweptHandbackValidator,
    status: runtimeAsyncAgentResultsFields.status,
    updatedAfter: v.string(),
    updatedBefore: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    page: v.array(asyncAgentDoc),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    page: Doc<"runtimeAsyncAgentResults">[];
    cursor: string;
    isDone: boolean;
  }> => {
    const result = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_handback_and_status_and_updatedAt", (q) =>
        q
          .eq("handback", args.handback)
          .eq("status", args.status)
          .gt("updatedAt", args.updatedAfter)
          .lt("updatedAt", args.updatedBefore),
      )
      .paginate({ cursor: args.cursor, numItems: OWED_RESULT_PAGE_SIZE });
    const page = await activeAccountRows(ctx, result.page);

    return {
      page: page,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/**
 * Moves a subagent result's hand-back: `detached` when the parent's run gives
 * up delivering it, `stored` when the parent reads it or is never told. A
 * stored row stays stored, and a running row is never marked stored. The
 * parent's own append and a late result's admission mark `stored` inside
 * their own transactions instead. A row whose resume waits in the parent's
 * queue is that resume's to deliver, so `stored` leaves it alone.
 * @returns true when a resume of the result waits in the parent's queue, so
 * the caller must not hand the result over itself
 */
export const markAsyncAgentHandback = internalMutation({
  args: {
    eventId: v.string(),
    handback: handbackMoveValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await asyncAgentResultRow(ctx, args.eventId);
    if (
      !row ||
      row.handback === "stored" ||
      (args.handback === "stored" && row.status === "processing")
    ) {
      return false;
    }
    await requireActiveAccount(ctx, row.accountId);
    if (
      args.handback === "stored" &&
      row.subagent !== undefined &&
      (await isResumeQueued(ctx, row.subagent.parentConversationKey, {
        resultEventId: row.eventId,
      }))
    ) {
      return true;
    }
    await ctx.db.patch(row._id, { handback: args.handback });

    return false;
  },
});

/**
 * Records an async run's outcome on its polling row. Used by subagents and by
 * async runs without a live ingress owner; `runtimeIngress.settle` writes the
 * same row in the envelope's transaction. With `onlyWhileProcessing` a row
 * that already has its outcome, or is gone, is left alone: the recovery sweep
 * fails a dead child's row that way.
 * @returns null after the result is updated or left alone
 */
export const updateAsyncAgentResult = internalMutation({
  args: {
    eventId: v.string(),
    ...asyncAgentOutcomeValidator.fields,
    onlyWhileProcessing: v.optional(v.boolean()),
    // `detached` hands the result to the recovery sweep in the same write,
    // for a child the sweep fails because its parent run died with it.
    handback: v.optional(v.literal("detached")),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { onlyWhileProcessing, handback, ...args },
  ): Promise<null> => {
    if (
      onlyWhileProcessing &&
      (await asyncAgentResultRow(ctx, args.eventId))?.status !== "processing"
    ) {
      return null;
    }
    if (!(await writeAsyncAgentResult(ctx, args.eventId, args, handback))) {
      throw new Error("Async agent result not found");
    }

    return null;
  },
});

/**
 * The polling row for `eventId`, or null, also when there is no id. A late
 * subagent result whose row is `stored` is one its parent has.
 */
export async function asyncAgentResultRow(
  ctx: QueryCtx,
  eventId: string | undefined,
): Promise<Doc<"runtimeAsyncAgentResults"> | null> {
  if (eventId === undefined) return null;

  return await ctx.db
    .query("runtimeAsyncAgentResults")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();
}

/**
 * Marks a subagent or async tool result's hand-back stored inside the
 * transaction that delivers it: the parent's append of the result row, or the
 * resume carrying it taking its owner (`accept` as owner, or the apply of a
 * queued one). Only when the row is `accountId`'s own and not stored already.
 */
export async function markResultStored(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  row: Doc<"runtimeAsyncAgentResults"> | Doc<"runtimeAsyncToolResults"> | null,
): Promise<void> {
  if (row?.accountId === accountId && row.handback !== "stored") {
    await ctx.db.patch(row._id, { handback: "stored" });
  }
}

/**
 * Whether a resume carrying this result waits, unexpired, in
 * `conversationKey`'s queue. A status read then leaves the result to it, so
 * the parent is told once and a read whose step is never saved loses nothing.
 */
async function isResumeQueued(
  ctx: QueryCtx,
  conversationKey: string,
  fence: { resultEventId: string } | { toolResultId: string },
): Promise<boolean> {
  const now = Date.now();
  const queued = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
      q.eq("conversationKey", conversationKey).eq("status", "queued"),
    )
    .take(QUEUED_RESUME_SCAN);

  return queued.some(
    (row): boolean =>
      row.expiresAt > now &&
      ("resultEventId" in fence
        ? row.resultEventId === fence.resultEventId
        : row.toolResultId === fence.toolResultId),
  );
}

/**
 * The async tool row for `resultId`, or null, also when there is no id. A
 * settled row that is `stored` is one its conversation has.
 */
export async function asyncToolResultRow(
  ctx: QueryCtx,
  resultId: string | undefined,
): Promise<Doc<"runtimeAsyncToolResults"> | null> {
  if (resultId === undefined) return null;

  return await ctx.db
    .query("runtimeAsyncToolResults")
    .withIndex("by_resultId", (q) => q.eq("resultId", resultId))
    .unique();
}

/**
 * Patches the polling row for `eventId` with a run's outcome. The outcome
 * never moves a hand-back; `handback` moves a row that is not stored to
 * `detached` in the same write.
 * @returns false when the row no longer exists
 */
export async function writeAsyncAgentResult(
  ctx: MutationCtx,
  eventId: string,
  outcome: Infer<typeof asyncAgentOutcomeValidator>,
  handback?: "detached",
): Promise<boolean> {
  const row = await asyncAgentResultRow(ctx, eventId);
  if (!row) return false;
  await requireActiveAccount(ctx, row.accountId);
  await ctx.db.patch(row._id, {
    status: outcome.status,
    response: outcome.response,
    error: outcome.error,
    approvals: outcome.approvals,
    questions: outcome.questions,
    ...(handback === "detached" && row.handback !== "stored"
      ? { handback: handback }
      : {}),
    updatedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
  });

  return true;
}

/**
 * Creates an async tool row.
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
  handler: async (ctx, args): Promise<boolean> => {
    const accountId = await requireActiveKeyAccount(ctx, args.conversationKey);
    const existing = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (existing) {
      return false;
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

    return true;
  },
});

/**
 * Records the sandbox a detached job launched on. A row that already settled
 * did so before its fence existed and keeps that result.
 * @returns null after the patch attempt
 */
export const bindAsyncToolResultSandbox = internalMutation({
  args: { resultId: v.string(), sandbox: reservedSandboxValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (!row || row.status !== "processing") return null;
    await requireActiveAccount(ctx, row.accountId);
    await ctx.db.patch(row._id, { sandbox: args.sandbox });

    return null;
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
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .unique();
    if (!row?.completionTokenHash) {
      return false;
    }

    return constantTimeDigestEqual(
      row.completionTokenHash,
      await sha256Hex(args.completionToken),
    );
  },
});

/**
 * Lists the still-processing rows one tool left on a conversation, oldest
 * first. The ask_questions intake reads this to find the prompt a reply answers.
 * @returns the public result documents still waiting to settle
 */
export const listPendingAsyncToolResults = internalQuery({
  args: { conversationKey: v.string(), toolName: v.string() },
  returns: v.array(asyncToolDoc),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("runtimeAsyncToolResults")
        .withIndex("by_conversationKey_and_toolName_and_status", (q) =>
          q
            .eq("conversationKey", args.conversationKey)
            .eq("toolName", args.toolName)
            .eq("status", "processing"),
        )
        .take(100)
    ).map(hideCompletionTokenHash),
});

/**
 * One page of async tool results in `status` whose hand-back is `handback`
 * (`pending` or `detached`), written inside the window, oldest first. Core's
 * recovery sweep resumes their conversations, walking every page each pass so
 * rows it must retry never crowd others out. A row of an inactive account is
 * left out: no resume of it can be admitted.
 * @returns the page and the cursor for the next one
 */
export const listOwedAsyncToolResults = internalQuery({
  args: {
    handback: sweptHandbackValidator,
    status: runtimeAsyncToolResultsFields.status,
    updatedAfter: v.string(),
    updatedBefore: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    page: v.array(asyncToolDoc),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    page: Infer<typeof asyncToolDoc>[];
    cursor: string;
    isDone: boolean;
  }> => {
    const result = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_handback_and_status_and_updatedAt", (q) =>
        q
          .eq("handback", args.handback)
          .eq("status", args.status)
          .gt("updatedAt", args.updatedAfter)
          .lt("updatedAt", args.updatedBefore),
      )
      .paginate({ cursor: args.cursor, numItems: OWED_RESULT_PAGE_SIZE });
    const page = (await activeAccountRows(ctx, result.page)).map(
      hideCompletionTokenHash,
    );

    return {
      page: page,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/**
 * Settles or observes an async tool row with optional processing-only CAS
 * semantics. A row that finishes starts its hand-back `pending`: the
 * conversation that started it owes the result its write until it stores it.
 * A hand-back already `detached` or `stored` keeps that state.
 * @returns the updated public row, or null when the conditional update is rejected
 */
export const updateAsyncToolResult = internalMutation({
  args: {
    resultId: v.string(),
    status: runtimeAsyncToolResultsFields.status,
    response: v.optional(v.any()),
    error: v.optional(v.string()),
    onlyWhenProcessing: v.optional(v.boolean()),
  },
  returns: v.union(asyncToolDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await asyncToolResultRow(ctx, args.resultId);
    if (row) await requireActiveAccount(ctx, row.accountId);
    if (!row || (args.onlyWhenProcessing && row.status !== "processing")) {
      return null;
    }
    // A job bound to a machine the reservation no longer names settles failed
    // whatever it reported: its workspace writes are unowned.
    const outcome =
      row.status === "processing" &&
      row.sandbox !== undefined &&
      !(await sandboxStillReserved(ctx, row.sandbox))
        ? {
            status: "failed" as const,
            response: undefined,
            error: REPLACED_SANDBOX_ERROR,
          }
        : { status: args.status, response: args.response, error: args.error };
    const patch = {
      ...outcome,
      ...(outcome.status !== "processing" && row.handback === undefined
        ? { handback: "pending" as const }
        : {}),
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    };
    await ctx.db.patch(row._id, patch);

    return hideCompletionTokenHash({ ...row, ...patch });
  },
});

/**
 * Moves a finished async tool result's hand-back: `detached` when the run that
 * started it gives up delivering it, `stored` when the model reads it with
 * async_status. A stored row stays stored, and a row still running is left
 * alone. The parent's own append and the continuation's admission mark
 * `stored` inside their own transactions instead. A row whose continuation
 * waits in the conversation's queue is that continuation's to deliver, so
 * `stored` leaves it alone.
 * @returns true when a continuation of the result waits in the
 * conversation's queue, so the caller must not hand the result over itself
 */
export const markAsyncToolHandback = internalMutation({
  args: {
    resultId: v.string(),
    handback: handbackMoveValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await asyncToolResultRow(ctx, args.resultId);
    if (!row || row.status === "processing" || row.handback === "stored") {
      return false;
    }
    await requireActiveAccount(ctx, row.accountId);
    if (
      args.handback === "stored" &&
      (await isResumeQueued(ctx, row.conversationKey, {
        toolResultId: row.resultId,
      }))
    ) {
      return true;
    }
    await ctx.db.patch(row._id, {
      handback: args.handback,
      updatedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });

    return false;
  },
});

/**
 * @returns the provider ID or null when the reservation is absent
 */
export const getSandboxReservation = internalQuery({
  args: { provider: sandboxProviderValidator, reservationKey: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> =>
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
 * What a release needs to pick credentials: the reserved machine, and the
 * instance row's record of whose credentials it runs on and which config
 * reserved it. The row is a best-effort mirror, so it is returned only while
 * it still names `externalId`, or the reserved machine when none is given.
 * With no reservation, the mirror row's own machine is the target.
 * @returns the reserved provider id, or null, and the matching instance row, or null
 */
export const getSandboxReleaseTarget = internalQuery({
  args: {
    accountId: v.id("accounts"),
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    externalId: v.optional(v.string()),
  },
  returns: sandboxReleaseTarget,
  handler: async (ctx, args): Promise<Infer<typeof sandboxReleaseTarget>> => {
    const reservation = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    const instances = (
      await ctx.db
        .query("sandboxInstances")
        .withIndex("by_reservationKey", (q) =>
          q.eq("reservationKey", args.reservationKey),
        )
        .collect()
    ).filter(
      (row) =>
        row.accountId === args.accountId && row.provider === args.provider,
    );
    // A mirror row a failed teardown left behind still names its machine.
    const externalId =
      args.externalId ??
      (reservation?.accountId === args.accountId
        ? reservation.externalId
        : instances[0]?.externalId) ??
      null;
    if (!externalId) return { externalId: null, instance: null };
    const instance = instances.find((row) => row.externalId === externalId);

    return {
      externalId: externalId,
      instance: instance
        ? {
            ownCredentials: instance.ownCredentials === true,
            sandboxConfigId: instance.sandboxConfigId,
          }
        : null,
    };
  },
});

/**
 * The reservation's sandbox and when it was claimed, for the executors that enforce
 * `lifecycle.maxLifetimeSeconds` themselves and would otherwise read the same row
 * twice. A reconnect only patches the row, so `claimedAt` stays the creation time of
 * the machine the key points at; replacing the sandbox deletes and re-inserts the
 * row, which restarts the clock. `expiresAt` is the idle deadline the sweeper
 * releases it at.
 * @returns the sandbox id, claim time and idle deadline, or null when the
 * reservation is absent
 */
export const getSandboxReservationRecord = internalQuery({
  args: { provider: sandboxProviderValidator, reservationKey: v.string() },
  returns: v.union(
    v.object({
      externalId: v.string(),
      claimedAt: v.number(),
      expiresAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{
    externalId: string;
    claimedAt: number;
    expiresAt: number;
  } | null> => {
    const reservation = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (!reservation) return null;

    return {
      externalId: reservation.externalId,
      claimedAt: reservation._creationTime,
      expiresAt: reservation.expiresAt,
    };
  },
});

/**
 * One page of reservations whose idle window has lapsed, oldest first.
 * @returns the expired reservations, up to `limit`
 */
export const listExpiredSandboxReservations = internalQuery({
  args: { limit: v.number() },
  returns: v.array(sandboxReservationSummary),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof sandboxReservationSummary>[]> => {
    const now = Math.floor(Date.now() / 1000);
    const rows = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(args.limit);

    return rows.map((row) => ({
      accountId: row.accountId,
      provider: row.provider,
      reservationKey: row.reservationKey,
      externalId: row.externalId,
      ttlSeconds: row.ttlSeconds,
    }));
  },
});

/**
 * Every snapshot image still building, for core's build watcher to finish once
 * the provider reports the build done. Builds last minutes, so the set stays small,
 * and a capped page would let builds stuck on failing checks starve the rest.
 * A build from before snapshots recorded their stage is left alone: nothing
 * boots it, so it must be taken again.
 * @returns the building snapshots
 */
export const listBuildingSandboxSnapshots = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      accountId: v.id("accounts"),
      scope: sandboxSnapshotScopeValidator,
      name: v.string(),
      provider: sandboxProviderValidator,
      baseImage: v.string(),
      externalImageId: v.string(),
    }),
  ),
  handler: async (
    ctx,
  ): Promise<
    Array<
      Required<
        Pick<
          Doc<"sandboxSnapshots">,
          | "accountId"
          | "scope"
          | "name"
          | "provider"
          | "baseImage"
          | "externalImageId"
        >
      >
    >
  > => {
    const rows = await ctx.db
      .query("sandboxSnapshots")
      .withIndex("by_status", (q) => q.eq("status", "building"))
      .collect();

    return rows.flatMap((row) =>
      row.scope
        ? [
            {
              accountId: row.accountId,
              scope: row.scope,
              name: row.name,
              provider: row.provider,
              baseImage: row.baseImage,
              externalImageId: row.externalImageId,
            },
          ]
        : [],
    );
  },
});

/**
 * Every reservation an account holds, whatever key shape reserved it, so a
 * deletion sweep releases each machine before the cascade drops the rows. Paged
 * because one account can hold more rows than a single query may read.
 * @returns one page of the account's reservations, and the cursor for the next
 */
export const listAccountSandboxReservations = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    page: v.array(sandboxReservationSummary),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args): Promise<SandboxReservationPage> => {
    const result = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .paginate({ cursor: args.cursor ?? null, numItems: 1_000 });

    return {
      page: result.page.map((row) => ({
        accountId: row.accountId,
        provider: row.provider,
        reservationKey: row.reservationKey,
        externalId: row.externalId,
      })),
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/**
 * Mirror rows no reservation names any more (a teardown that failed, or the old
 * prune), still carrying the provider id the sweeper needs to tear them down. Bounded to rows idle longer than a whole
 * reservation TTL so a live sandbox is never mistaken for one. `ephemeral` rows are
 * left out by the index, so they never fill the page: their key is a provider id, not
 * a reconnect key, and the hourly accrual deletes them. Paged oldest first by
 * cursor: a mirror whose reservation the sweeper deferred keeps its age, so
 * reserved rows can fill any fixed prefix. The idle cut is checked per row rather
 * than in the index range, so one pass's cursor still fits the next pass's query.
 * @returns one page's orphaned mirror rows, and the cursor for the next page
 */
export const listOrphanedSandboxInstances = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  returns: v.object({
    page: v.array(sandboxReservationSummary),
    cursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args): Promise<SandboxReservationPage> => {
    const idleBefore = Date.now() - SANDBOX_RESERVATION_TTL_SECONDS * 1000;
    const result = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_ephemeral_and_lastUsedAt", (q) =>
        q.eq("ephemeral", undefined),
      )
      .paginate({ cursor: args.cursor, numItems: args.limit });

    const orphans: Infer<typeof sandboxReservationSummary>[] = [];
    for (const row of result.page) {
      // Oldest first: the first row still in use ends the idle ones.
      if (row.lastUsedAt >= idleBefore) {
        return { page: orphans, cursor: null, isDone: true };
      }
      const reservation = await ctx.db
        .query("sandboxReservations")
        .withIndex("by_provider_and_reservationKey", (q) =>
          q
            .eq("provider", row.provider)
            .eq("reservationKey", row.reservationKey),
        )
        .unique();
      if (reservation) continue;
      orphans.push({
        accountId: row.accountId,
        provider: row.provider,
        reservationKey: row.reservationKey,
        externalId: row.externalId,
      });
    }

    return {
      page: orphans,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
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
    accountId: v.id("accounts"),
    ttlSeconds: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    // The reservation key is a hashed workspace namespace, so the owning account
    // can't be parsed from it. Core passes accountId explicitly.
    await requireActiveAccount(ctx, args.accountId);
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
      accountId: args.accountId,
      provider: args.provider,
      reservationKey: args.reservationKey,
      externalId: args.externalId,
      expiresAt: reservationExpiresAt(args.ttlSeconds),
      ttlSeconds: args.ttlSeconds,
    });

    return true;
  },
});

/**
 * Refreshes the idle deadline of a reservation that still names this sandbox
 * and belongs to this account. Never inserts or repoints: a released or
 * replaced key is a no-op.
 * @returns null after the patch attempt
 */
export const saveSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    externalId: v.string(),
    accountId: v.id("accounts"),
    ttlSeconds: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await requireActiveAccount(ctx, args.accountId);
    const row = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (
      !row ||
      row.accountId !== args.accountId ||
      row.externalId !== args.externalId
    ) {
      return null;
    }
    await ctx.db.patch(row._id, {
      expiresAt: reservationExpiresAt(args.ttlSeconds ?? row.ttlSeconds),
    });

    return null;
  },
});

/**
 * Pushes the deadline out on reservations the sweeper could not clear, so one it can
 * never clear stops holding the head of the `by_expiresAt` page. Patches only, so a
 * released row stays gone. Bypasses the active-account guard: a suspended account's
 * rows are exactly the ones that would otherwise block the page forever.
 * @returns the number of rows whose deadline moved
 */
export const deferSandboxReservations = internalMutation({
  args: {
    accountId: v.id("accounts"),
    reservations: v.array(
      v.object({
        provider: sandboxProviderValidator,
        reservationKey: v.string(),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    let deferred = 0;
    for (const reservation of args.reservations) {
      const row = await ctx.db
        .query("sandboxReservations")
        .withIndex("by_provider_and_reservationKey", (q) =>
          q
            .eq("provider", reservation.provider)
            .eq("reservationKey", reservation.reservationKey),
        )
        .unique();
      if (!row || row.accountId !== args.accountId) continue;
      await ctx.db.patch(row._id, {
        expiresAt: reservationExpiresAt(row.ttlSeconds),
      });
      deferred += 1;
    }

    return deferred;
  },
});

/**
 * Deletes a reservation while it still names `expectedExternalId` (when given)
 * and, with `onlyExpired`, only once its deadline has lapsed: the sweeper takes
 * a row this way before the provider teardown, so a run that refreshed the
 * deadline or replaced the machine in between keeps its row. A key no row names
 * is the caller's to tear down as well, since no run can reach a machine
 * without a reservation naming it.
 * @returns whether the caller now owns the teardown of that machine
 */
export const deleteSandboxReservation = internalMutation({
  args: {
    provider: sandboxProviderValidator,
    reservationKey: v.string(),
    expectedExternalId: v.optional(v.string()),
    onlyExpired: v.optional(v.boolean()),
    accountId: v.id("accounts"),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    await requireActiveAccount(ctx, args.accountId);
    const row = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_provider_and_reservationKey", (q) =>
        q
          .eq("provider", args.provider)
          .eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (!row) return true;
    if (
      row.accountId !== args.accountId ||
      (args.expectedExternalId !== undefined &&
        row.externalId !== args.expectedExternalId) ||
      (args.onlyExpired === true &&
        row.expiresAt >= Math.floor(Date.now() / 1000))
    ) {
      return false;
    }
    await ctx.db.delete(row._id);

    return true;
  },
});

/**
 * Deletes one bounded batch of the runtime rows owned by a single agent, so a
 * deleted agent does not leave its conversations, queued work and status rows
 * behind for the account-wide purge that may never run.
 *
 * Every table reached here is keyed by the account-and-agent scoped
 * conversation key, which lets each read be a prefix range over that key rather
 * than a scan of the account's rows. Tables with no conversation key
 * (`runtimeClaims`, sandbox reservations) stay with
 * `deleteAccountRuntimeData`: they carry no agent, so no prefix identifies them.
 *
 * Like the account purge, this accepts an agent that is already gone: the caller
 * deletes the row and drains the rows afterwards.
 * @returns per-table deletion counts and their total
 */
export const deleteAgentRuntimeData = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
  },
  returns: v.object({
    conversationsDeleted: v.number(),
    coordinatorDeleted: v.number(),
    ingressDeleted: v.number(),
    applicationDeleted: v.number(),
    harnessSessionDeleted: v.number(),
    asyncAgentResultDeleted: v.number(),
    asyncToolResultDeleted: v.number(),
    totalDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    const prefix = `acct:${args.accountId}:agent:${args.agentId}:`;
    // Every key under this agent sorts between the prefix and the prefix plus
    // the highest code point, which is what makes each read a range, not a scan.
    const prefixEnd = `${prefix}\uffff`;
    const conversationRows = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    const coordinatorRows = await ctx.db
      .query("runtimeConversationCoordinators")
      .withIndex("by_conversationKey", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    const ingressRows = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    const applicationRows = await ctx.db
      .query("runtimeIngressApplications")
      .withIndex("by_conversationKey_and_createdAt", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    const harnessSessionRows = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_conversationKey", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    const asyncAgentRows = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_conversationKey", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    const asyncToolRows = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_conversationKey_and_toolName_and_status", (q) =>
        q.gte("conversationKey", prefix).lt("conversationKey", prefixEnd),
      )
      .take(RUNTIME_DELETE_BATCH_SIZE);
    for (const row of [
      ...conversationRows,
      ...coordinatorRows,
      ...ingressRows,
      ...applicationRows,
      ...harnessSessionRows,
      ...asyncAgentRows,
      ...asyncToolRows,
    ])
      await ctx.db.delete(row._id);
    // A full batch means the table had more than one pass can hold, so keep
    // going. The caller fires this once and never has to loop.
    if (
      [
        conversationRows,
        coordinatorRows,
        ingressRows,
        applicationRows,
        harnessSessionRows,
        asyncAgentRows,
        asyncToolRows,
      ].some((batch) => batch.length === RUNTIME_DELETE_BATCH_SIZE)
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.runtime.deleteAgentRuntimeData,
        args,
      );
    }

    return {
      conversationsDeleted: conversationRows.length,
      coordinatorDeleted: coordinatorRows.length,
      ingressDeleted: ingressRows.length,
      applicationDeleted: applicationRows.length,
      harnessSessionDeleted: harnessSessionRows.length,
      asyncAgentResultDeleted: asyncAgentRows.length,
      asyncToolResultDeleted: asyncToolRows.length,
      totalDeleted:
        conversationRows.length +
        coordinatorRows.length +
        ingressRows.length +
        applicationRows.length +
        harnessSessionRows.length +
        asyncAgentRows.length +
        asyncToolRows.length,
    };
  },
});

/**
 * Deletes one bounded batch of every runtime row owned by an account. This
 * cleanup path intentionally accepts disabled or already-removed accounts.
 * @returns per-table deletion counts and their total
 */
export const deleteAccountRuntimeData = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.object({
    conversationsDeleted: v.number(),
    processedEventsDeleted: v.number(),
    asyncAgentResultDeleted: v.number(),
    asyncToolResultDeleted: v.number(),
    harnessSessionDeleted: v.number(),
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
    const coordinatorRows = await ctx.db
      .query("runtimeConversationCoordinators")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const ingressRows = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_accountId_and_runId", (q) =>
        q.eq("accountId", args.accountId),
      )
      .take(100);
    const applicationRows = await ctx.db
      .query("runtimeIngressApplications")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const agentRows = await ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const harnessSessionRows = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const toolRows = await ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const reservationRows = await ctx.db
      .query("sandboxReservations")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    for (const row of [
      ...conversationRows,
      ...claimRows,
      ...coordinatorRows,
      ...ingressRows,
      ...applicationRows,
      ...harnessSessionRows,
      ...agentRows,
      ...toolRows,
      ...reservationRows,
    ])
      await ctx.db.delete(row._id);

    return {
      conversationsDeleted: conversationRows.length,
      processedEventsDeleted:
        claimRows.length +
        coordinatorRows.length +
        ingressRows.length +
        applicationRows.length,
      asyncAgentResultDeleted: agentRows.length,
      asyncToolResultDeleted: toolRows.length,
      harnessSessionDeleted: harnessSessionRows.length,
      sandboxReservationDeleted: reservationRows.length,
      totalDeleted:
        conversationRows.length +
        claimRows.length +
        coordinatorRows.length +
        ingressRows.length +
        applicationRows.length +
        harnessSessionRows.length +
        agentRows.length +
        toolRows.length +
        reservationRows.length,
    };
  },
});

/**
 * Deletes expired operational rows in bounded batches and schedules
 * continuation when needed. This maintenance path intentionally bypasses the
 * active-account guard. `sandboxReservations` is deliberately absent. Core's
 * sandbox sweeper expires that table instead, provider first and row second.
 * @returns the number of rows deleted in this batch
 */
export const pruneExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
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
    const rows = [...claims, ...agentResults, ...toolResults];
    for (const row of rows) await ctx.db.delete(row._id);
    if (
      [claims, agentResults, toolResults].some((batch) => batch.length === 100)
    ) {
      await ctx.scheduler.runAfter(0, internal.runtime.pruneExpired, {});
    }

    return rows.length;
  },
});

/**
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

/** Compares fixed-length hexadecimal digests without content-dependent exits. */
function constantTimeDigestEqual(actual: string, expected: string): boolean {
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }

  return difference === 0;
}

/** Removes callback authorization from general async-tool result reads. */
function hideCompletionTokenHash<T extends { completionTokenHash?: string }>(
  row: T,
): Omit<T, "completionTokenHash"> {
  const { completionTokenHash: _hidden, ...publicRow } = row;

  return publicRow;
}

/**
 * The idle deadline a claim or refresh writes. Core passes a shorter window for a
 * sandbox only one conversation uses; it never extends past the default.
 */
function reservationExpiresAt(ttlSeconds: number | undefined): number {
  const ttl = Math.min(
    Math.max(ttlSeconds ?? SANDBOX_RESERVATION_TTL_SECONDS, 60),
    SANDBOX_RESERVATION_TTL_SECONDS,
  );

  return Math.floor(Date.now() / 1000) + ttl;
}

/**
 * Requires an account to exist and remain active in the runtime-write transaction.
 * @param ctx Convex mutation context
 * @param accountId account ID embedded in the runtime row or key
 * @throws when the account is missing, disabled, or malformed
 */
async function sandboxStillReserved(
  ctx: MutationCtx,
  sandbox: Infer<typeof reservedSandboxValidator>,
): Promise<boolean> {
  const row = await ctx.db
    .query("sandboxReservations")
    .withIndex("by_provider_and_reservationKey", (q) =>
      q
        .eq("provider", sandbox.provider)
        .eq("reservationKey", sandbox.reservationKey),
    )
    .unique();

  return row?.externalId === sandbox.externalId;
}

/**
 * The rows of active accounts, in order: a row of an inactive account is left
 * out of a recovery sweep's page, since no resume of it can be admitted.
 */
async function activeAccountRows<T extends { accountId: Id<"accounts"> }>(
  ctx: QueryCtx,
  rows: T[],
): Promise<T[]> {
  const page: T[] = [];
  for (const row of rows) {
    if ((await ctx.db.get(row.accountId))?.status === "active") {
      page.push(row);
    }
  }

  return page;
}
