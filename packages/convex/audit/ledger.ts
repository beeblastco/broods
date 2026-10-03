/**
 * Internal functions over the audit ledger: append from HTTP actions and
 * core, read a page since a seq, verify the chain, and prune rows past retention.
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
import { auditSinkRow } from "../model/auditSinks";
import { auditEventsFields } from "../schema";

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 200;
const PRUNE_ACCOUNT_PAGE_SIZE = 20;
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
 * Delete rows older than each account's retention window, one page of
 * accounts per invocation. A sink's `exportedSeq` is a floor, so a row it has
 * not exported is never dropped, and the head row stays so the chain always
 * has a tip to link from. Reschedules itself while a batch fills or accounts
 * remain.
 */
export const pruneExpired = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    // One head row per account that has ever written to its ledger.
    const tips = await ctx.db.query("auditChainHeads").paginate({
      numItems: PRUNE_ACCOUNT_PAGE_SIZE,
      cursor: args.cursor ?? null,
    });
    // One delete budget for the whole page keeps the mutation's writes
    // bounded however many accounts have rows to drop.
    let budget = PRUNE_BATCH_SIZE;
    for (const tip of tips.page) {
      if (budget === 0) break;
      budget -= await pruneAccount(ctx, tip, now, budget);
    }
    // Out of budget: this page may hold more, so it runs again.
    if (budget === 0 || !tips.isDone) {
      await ctx.scheduler.runAfter(0, internal.audit.ledger.pruneExpired, {
        now: now,
        cursor: budget === 0 ? args.cursor : tips.continueCursor,
      });
    }

    return PRUNE_BATCH_SIZE - budget;
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
 * the head), at most 1000 rows per call; `checkedTo` says where it stopped.
 * Stored rows are gapless from the oldest kept row to the head, so the nearest
 * stored row below the range must be its direct predecessor and anchors the
 * first link: a row deleted at the range start is reported, a pruned prefix
 * is not. Without `toSeq` the last row must also match the head, so a dropped
 * tail is reported at the first missing seq.
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
    // The genesis row links to ""; anything else anchors on the nearest
    // stored row below it.
    const before =
      first?.seq === 1
        ? null
        : await rowBelow(ctx, args.accountId, first?.seq ?? fromSeq);
    if (!first) {
      const missing = missingFromEmptyRange(
        before,
        await chainHead(ctx, args.accountId),
        fromSeq,
        toSeq,
      );

      return missing === null
        ? { ok: true }
        : { ok: false, brokenAtSeq: missing };
    }
    if (before && before.seq !== first.seq - 1) {
      return { ok: false, brokenAtSeq: before.seq + 1 };
    }

    const result = await verifyChainRows(
      rows,
      first.seq === 1 ? "" : before?.hash,
    );
    const last = rows[rows.length - 1] ?? first;
    const range = { checkedFrom: first.seq, checkedTo: last.seq };
    if (!result.ok) return { ...result, ...range };

    // The tail check only applies when the walk reached the end of the ledger.
    if (toSeq !== undefined || rows.length === VERIFY_ROWS_MAX) {
      return { ok: true, ...range };
    }
    const tip = await chainHead(ctx, args.accountId);
    if (tip && (tip.seq !== last.seq || tip.hash !== last.hash)) {
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
 * The seq a verify of an empty range must report as missing, or null when
 * nothing should be there. The row after a stored one exists unless that one
 * is the head, and an open-ended range always holds the head row, which is
 * never pruned.
 */
function missingFromEmptyRange(
  before: Doc<"auditEvents"> | null,
  tip: AuditChainHead,
  fromSeq: number,
  toSeq: number | undefined,
): number | null {
  if (!tip) return null;
  if (before) return tip.seq > before.seq ? before.seq + 1 : null;

  return toSeq === undefined && tip.seq >= fromSeq ? tip.seq : null;
}

/**
 * Delete up to `limit` rows for one account: older than its retention, never
 * the head, and never past what its sink exported when it has one. Rows are
 * read one at a time, so an account with nothing to drop reads one row.
 * @returns the count deleted
 */
async function pruneAccount(
  ctx: MutationCtx,
  tip: Doc<"auditChainHeads">,
  now: number,
  limit: number,
): Promise<number> {
  const account = await ctx.db.get(tip.accountId);
  if (!account) return 0;
  const sink = await auditSinkRow(ctx.db, tip.accountId);
  const cutoff =
    now - (account.auditRetentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  // Below the head, which is the chain tip and stays whatever its age, and
  // with a sink also at or below its watermark.
  const belowSeq = sink ? Math.min(sink.exportedSeq + 1, tip.seq) : tip.seq;
  // Walking in seq order and stopping at the first row inside the window
  // only ever removes a prefix, so the kept range has no gap to verify over.
  const expired: Id<"auditEvents">[] = [];
  for await (const row of ctx.db
    .query("auditEvents")
    .withIndex("by_accountId_and_seq", (q) =>
      q.eq("accountId", tip.accountId).lt("seq", belowSeq),
    )) {
    if (expired.length === limit || row.at >= cutoff) break;
    expired.push(row._id);
  }
  for (const rowId of expired) await ctx.db.delete(rowId);

  return expired.length;
}

/** The nearest stored row with a seq below `seq`, or null when none is kept. */
async function rowBelow(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  seq: number,
): Promise<Doc<"auditEvents"> | null> {
  return await ctx.db
    .query("auditEvents")
    .withIndex("by_accountId_and_seq", (q) =>
      q.eq("accountId", accountId).lt("seq", seq),
    )
    .order("desc")
    .first();
}
