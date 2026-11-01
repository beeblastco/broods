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

export const head = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: chainHeadValidator,
  handler: async (ctx, args): Promise<AuditChainHead> => {
    return await chainHead(ctx, args.accountId);
  },
});

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

export const pruneExpired = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const tips = await ctx.db.query("auditChainHeads").paginate({
      numItems: PRUNE_ACCOUNT_PAGE_SIZE,
      cursor: args.cursor ?? null,
    });
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

// Kept rows are gapless up to the head, so the nearest stored row below the range must be its
// predecessor: a deleted row is reported, a pruned prefix is not.
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

// The head row is never pruned, and every kept row below the head has a successor.
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
  // Never the head (the chain tip), nor a row the sink has not exported.
  const belowSeq = sink ? Math.min(sink.exportedSeq + 1, tip.seq) : tip.seq;
  // Stopping at the first row in the window removes only a prefix, so no gap is left.
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
