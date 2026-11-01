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
  asyncToolDeliveryValidator,
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
// The per-query read limit counts bytes, and one tool result can outweigh 1000 text rows.
const CONVERSATION_EVENT_PAGE_BYTES = 4 * 1_024 * 1_024;
const CONVERSATION_EVENT_PAGE_SIZE = 512;
const DAY_SECONDS = 24 * 60 * 60;
// Core's `DEFAULT_INGRESS_MAX_COUNT`: every queued envelope is read to find a resume.
const QUEUED_RESUME_SCAN = 100;
const OWED_RESULT_PAGE_SIZE = 100;

const REPLACED_SANDBOX_ERROR =
  "Background job ran on a sandbox that has since been replaced";

const RUNTIME_DELETE_BATCH_SIZE = 100;

// Only core's sandbox sweeper may expire a reservation: the row is the sole copy of
// `externalId`, so deleting it before the sandbox strands the machine.
export const SANDBOX_RESERVATION_TTL_SECONDS = 7 * DAY_SECONDS;

export const conversationEventsValidator = v.array(
  v.object({
    cursor: v.string(),
    dedupeKey: runtimeConversationEventsFields.dedupeKey,
    event: v.any(),
  }),
);

export const asyncAgentOutcomeValidator = v.object({
  status: runtimeAsyncAgentResultsFields.status,
  response: runtimeAsyncAgentResultsFields.response,
  error: runtimeAsyncAgentResultsFields.error,
  approvals: runtimeAsyncAgentResultsFields.approvals,
  questions: runtimeAsyncAgentResultsFields.questions,
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

export async function insertConversationEvents(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  conversationKey: string,
  events: Infer<typeof conversationEventsValidator>,
): Promise<void> {
  for (const entry of events) {
    // A stored dedupe key means the first append committed and only its reply was lost.
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
      // Backward to the newest system row with the prefix (core's compaction summary);
      // `continueCursor` is then the next `beforeCursor`.
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
      // Checked before the push, so a row over budget still lands and the cursor moves.
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
      // Pending from the start: a child orphaned before any detach still reaches the sweep.
      ...(args.subagent ? { handback: "pending" as const } : {}),
      status: "processing",
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY_SECONDS,
    });

    return true;
  },
});

export const getAsyncAgentResult = internalQuery({
  args: { eventId: v.string() },
  returns: v.union(asyncAgentDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"runtimeAsyncAgentResults"> | null> =>
    await asyncAgentResultRow(ctx, args.eventId),
});

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

// True when a queued resume already carries the result: the caller must not hand it over.
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

export const updateAsyncAgentResult = internalMutation({
  args: {
    eventId: v.string(),
    ...asyncAgentOutcomeValidator.fields,
    onlyWhileProcessing: v.optional(v.boolean()),
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

// Call in the transaction that delivers the result, so row and flag never disagree.
export async function markResultStored(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  row: Doc<"runtimeAsyncAgentResults"> | Doc<"runtimeAsyncToolResults"> | null,
): Promise<void> {
  if (row?.accountId === accountId && row.handback !== "stored") {
    await ctx.db.patch(row._id, { handback: "stored" });
  }
}

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

export const createAsyncToolResult = internalMutation({
  args: {
    resultId: v.string(),
    parentEventId: v.string(),
    conversationKey: v.string(),
    toolName: v.string(),
    toolCallId: v.string(),
    input: v.any(),
    delivery: v.optional(asyncToolDeliveryValidator),
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

// A row that settled before its sandbox fence existed keeps that result.
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
    // A job whose sandbox was since replaced fails whatever it reported: its writes are unowned.
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

// True when a queued continuation already carries the result: the caller must not hand it over.
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

// `sandboxInstances` is a best-effort mirror: its row counts only while it names the target.
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
      // A reconnect only patches the row and a replacement re-inserts it: this is machine age.
      claimedAt: reservation._creationTime,
      expiresAt: reservation.expiresAt,
    };
  },
});

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

// Uncapped: builds last minutes, and a capped page would let stuck builds starve the rest.
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

// Paged since deferred reservations keep their age and can fill any prefix; the idle cut is
// per row so one pass's cursor fits the next. Ephemeral rows are skipped: no reservation
// names them and the hourly accrual deletes them.
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
    // The key is a hashed workspace namespace, so the account can't be parsed from it.
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

// Unclearable rows must not hold the head of the `by_expiresAt` page. No active-account
// guard: a suspended account's rows are exactly the ones that would block it forever.
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

// True hands the caller the machine's teardown; a key no row names is unreachable by any run.
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

// Claims and sandbox reservations carry no agent, so only deleteAccountRuntimeData drops them.
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

// No active-account guard: disabled and already-removed accounts are purged too.
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

// No active-account guard. `sandboxReservations` is core's sweeper's: provider first, row second.
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

function claimKeyForAccount(accountId: string, key: string): string {
  if (!key.startsWith("acct:")) {
    return `acct:${accountId}:claim:${key}`;
  }
  if (accountIdFromKey(key) !== accountId) {
    throw new Error("Runtime claim key does not belong to accountId");
  }

  return key;
}

function constantTimeDigestEqual(actual: string, expected: string): boolean {
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }

  return difference === 0;
}

function hideCompletionTokenHash<T extends { completionTokenHash?: string }>(
  row: T,
): Omit<T, "completionTokenHash"> {
  const { completionTokenHash: _hidden, ...publicRow } = row;

  return publicRow;
}

function reservationExpiresAt(ttlSeconds: number | undefined): number {
  const ttl = Math.min(
    Math.max(ttlSeconds ?? SANDBOX_RESERVATION_TTL_SECONDS, 60),
    SANDBOX_RESERVATION_TTL_SECONDS,
  );

  return Math.floor(Date.now() / 1000) + ttl;
}

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

// No resume of an inactive account can be admitted, so recovery sweeps skip its rows.
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
