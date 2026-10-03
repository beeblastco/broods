/**
 * Internal functions over the audit ledger: append from HTTP actions and
 * core, read a page since a seq, verify the chain, and prune exported rows.
 * The chain itself lives in `model/auditEvents.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import {
  AUDIT_LIST_LIMIT_MAX,
  appendAuditEvent,
  auditChainHeadRow,
  verifyChainRows,
  type AuditChainHead,
  type ChainVerification,
} from "../model/auditEvents";
import { auditEventsFields } from "../schema";

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 200;
const PRUNE_SINK_PAGE_SIZE = 20;
const VERIFY_ROWS_MAX = 1000;

const auditEventDoc = v.object({
  ...auditEventsFields,
  _id: v.id("auditEvents"),
  _creationTime: v.number(),
});

const chainHeadValidator = v.union(
  v.object({ seq: v.number(), hash: v.string() }),
  v.null(),
);

/** The ledger tip: null for an account that has never written a row. */
export const head = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: chainHeadValidator,
  handler: async (ctx, args): Promise<AuditChainHead> => {
    return await chainHead(ctx, args.accountId);
  },
});

/** Rows with `seq > since`, ascending, at most `limit` (capped at 500). */
export const list = internalQuery({
  args: {
    accountId: v.id("accounts"),
    since: v.number(),
    limit: v.number(),
  },
  returns: v.array(auditEventDoc),
  handler: async (ctx, args): Promise<Doc<"auditEvents">[]> => {
    return await ctx.db
      .query("auditEvents")
      .withIndex("by_accountId_and_seq", (q) =>
        q.eq("accountId", args.accountId).gt("seq", args.since),
      )
      .take(
        Math.min(Math.max(1, Math.floor(args.limit)), AUDIT_LIST_LIMIT_MAX),
      );
  },
});

/**
 * Delete rows a sink already exported and that are older than the account's
 * retention window. The head row stays so the chain always has a tip to link
 * from. Accounts without a sink keep every row. Reschedules itself while a
 * batch fills.
 */
export const pruneExpired = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const sinks = await ctx.db.query("auditSinks").paginate({
      numItems: PRUNE_SINK_PAGE_SIZE,
      cursor: args.cursor ?? null,
    });
    let deleted = 0;
    let batchFilled = false;
    for (const sink of sinks.page) {
      const count = await pruneAccount(ctx, sink, now);
      deleted += count;
      batchFilled ||= count === PRUNE_BATCH_SIZE;
    }
    if (batchFilled || !sinks.isDone) {
      await ctx.scheduler.runAfter(0, internal.audit.ledger.pruneExpired, {
        now: now,
        cursor: batchFilled ? args.cursor : sinks.continueCursor,
      });
    }

    return deleted;
  },
});

/** Append one row from an HTTP action or from core. */
export const record = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.optional(v.id("projects")),
    stageId: v.optional(v.id("stages")),
    traceId: v.optional(v.string()),
    actor: auditEventsFields.actor,
    action: v.string(),
    resource: auditEventsFields.resource,
    summary: v.string(),
    detailsJson: v.optional(v.string()),
  },
  returns: v.id("auditEvents"),
  handler: async (ctx, args): Promise<Id<"auditEvents">> => {
    return await appendAuditEvent(ctx.db, {
      accountId: args.accountId,
      projectId: args.projectId,
      stageId: args.stageId,
      traceId: args.traceId,
      actor: args.actor,
      action: args.action,
      resource: args.resource,
      summary: args.summary,
      detailsJson: args.detailsJson,
    });
  },
});

/**
 * Recompute the chain over `[fromSeq, toSeq]` (defaults: oldest kept row to
 * the head). The row before `fromSeq` anchors the first link when it is still
 * stored. Without `toSeq` the last row must also match the head, so a dropped
 * tail is reported at the first missing seq. At most 1000 rows per call.
 */
export const verifyChain = internalQuery({
  args: {
    accountId: v.id("accounts"),
    fromSeq: v.optional(v.number()),
    toSeq: v.optional(v.number()),
  },
  returns: v.object({
    ok: v.boolean(),
    brokenAtSeq: v.optional(v.number()),
    checkedFrom: v.optional(v.number()),
    checkedTo: v.optional(v.number()),
  }),
  handler: async (ctx, args): Promise<ChainVerification> => {
    const fromSeq = Math.max(1, Math.floor(args.fromSeq ?? 1));
    const toSeq = args.toSeq === undefined ? undefined : Math.floor(args.toSeq);
    const rows = await ctx.db
      .query("auditEvents")
      .withIndex("by_accountId_and_seq", (q) => {
        const lower = q.eq("accountId", args.accountId).gte("seq", fromSeq);

        return toSeq === undefined ? lower : lower.lte("seq", toSeq);
      })
      .take(VERIFY_ROWS_MAX);
    const first = rows[0];
    if (!first) return { ok: true };

    // The genesis row links to ""; any other range anchors on the row before
    // it when that row is still stored.
    const before =
      first.seq === 1
        ? null
        : await ctx.db
            .query("auditEvents")
            .withIndex("by_accountId_and_seq", (q) =>
              q.eq("accountId", args.accountId).eq("seq", first.seq - 1),
            )
            .unique();
    const result = await verifyChainRows(
      rows,
      first.seq === 1 ? "" : before?.hash,
    );
    const last = rows[rows.length - 1] ?? first;
    const range = { checkedFrom: first.seq, checkedTo: last.seq };
    if (!result.ok) return { ...result, ...range };

    const tip = await chainHead(ctx, args.accountId);
    const reachedEnd = toSeq === undefined && rows.length < VERIFY_ROWS_MAX;
    if (reachedEnd && tip && (tip.seq !== last.seq || tip.hash !== last.hash)) {
      return { ok: false, brokenAtSeq: last.seq + 1, ...range };
    }

    return { ok: true, ...range };
  },
});

async function chainHead(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
): Promise<AuditChainHead> {
  const row = await auditChainHeadRow(ctx.db, accountId);

  return row ? { seq: row.seq, hash: row.hash } : null;
}

/**
 * One batch of deletes for one sink's account: rows at or below the exported
 * watermark, older than retention, never the head. Returns the count deleted;
 * a full batch means there may be more.
 */
async function pruneAccount(
  ctx: MutationCtx,
  sink: Doc<"auditSinks">,
  now: number,
): Promise<number> {
  const account = await ctx.db.get(sink.accountId);
  const tip = await chainHead(ctx, sink.accountId);
  if (!account || !tip) return 0;
  const cutoff =
    now - (account.auditRetentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  // Below the watermark and below the head: the head row is the chain tip
  // and stays whatever its age.
  const belowSeq = Math.min(sink.exportedSeq + 1, tip.seq);
  const rows = await ctx.db
    .query("auditEvents")
    .withIndex("by_accountId_and_seq", (q) =>
      q.eq("accountId", sink.accountId).lt("seq", belowSeq),
    )
    .take(PRUNE_BATCH_SIZE);
  let deleted = 0;
  for (const row of rows) {
    // Walking in seq order and stopping at the first row inside the window
    // only ever removes a prefix, so the kept range has no gap to verify over.
    if (row.at >= cutoff) break;
    await ctx.db.delete(row._id);
    deleted += 1;
  }

  return deleted;
}
