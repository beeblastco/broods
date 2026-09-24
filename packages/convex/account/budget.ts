/**
 * The monthly compute budget, as core and the dashboard reach it: core reads
 * the budget at admission, records the usage only it sees (hosted-MCP invokes,
 * media egress) and claims the 80% warning; the dashboard reads percentages.
 * Sandbox time is metered by the sandbox mirror itself; storage by the daily
 * snapshot in `aws/storageMeter.ts`. Math lives in `model/usageMeter.ts`.
 */

import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { authKit } from "../auth";
import {
  addUsage,
  budgetStatus,
  budgetUsage,
  claimBudgetWarning,
  type BudgetStatus,
  type BudgetUsage,
} from "../model/usageMeter";
import { getActiveAccountForUser } from "../org/orgs";
import { planValidator, usageQuantityFields } from "../schema";

// Core's retries end within a minute; a day of ids is ample.
const USAGE_WRITE_RETENTION_MS = 24 * 60 * 60 * 1000;
const USAGE_WRITE_PRUNE_BATCH = 500;

const budgetStatusValidator = v.object({
  enforced: v.boolean(),
  plan: planValidator,
  month: v.string(),
  usedEur: v.number(),
  limitEur: v.number(),
  runsPerMinute: v.number(),
  warned: v.boolean(),
});

const budgetUsageValidator = v.object({
  enforced: v.boolean(),
  plan: planValidator,
  month: v.string(),
  usedPercent: v.union(v.number(), v.null()),
  categories: v.object({
    sandboxes: v.number(),
    hostedMcp: v.number(),
    storage: v.number(),
    egress: v.number(),
  }),
  level: v.union(v.literal("ok"), v.literal("warning"), v.literal("exhausted")),
  runsPerMinute: v.number(),
});

/**
 * Claim this month's 80% warning.
 * @returns true for the one caller that should tell the user
 */
export const claimWarning = internalMutation({
  args: { accountId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);

    return accountId
      ? await claimBudgetWarning(ctx, accountId, Date.now())
      : false;
  },
});

/** Core's check at run admission and sandbox start. An unknown id reads as unlimited. */
export const get = internalQuery({
  args: { accountId: v.string() },
  returns: v.union(budgetStatusValidator, v.null()),
  handler: async (ctx, args): Promise<BudgetStatus | null> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);

    return accountId ? await budgetStatus(ctx, accountId, Date.now()) : null;
  },
});

/**
 * Dashboard billing panel: the active org's month as percentages. Euro
 * figures never leave the backend, so the plan budgets stay private.
 */
export const getForActiveOrg = query({
  args: {},
  returns: v.union(budgetUsageValidator, v.null()),
  handler: async (ctx): Promise<BudgetUsage | null> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx);

    return account ? await budgetUsage(ctx, account._id, Date.now()) : null;
  },
});

/** One page of account ids, for the storage snapshot. */
export const listAccountIds = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.id("accounts")),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<
    Pick<PaginationResult<Id<"accounts">>, "page" | "isDone" | "continueCursor">
  > => {
    const result = await ctx.db.query("accounts").paginate(args.paginationOpts);

    return {
      page: result.page.map((account) => account._id),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** The account's workspace ids, whose S3 namespaces the storage snapshot sums. */
export const listWorkspaceIds = internalQuery({
  args: {
    accountId: v.id("accounts"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(v.id("workspaceConfigs")),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<
    Pick<
      PaginationResult<Id<"workspaceConfigs">>,
      "page" | "isDone" | "continueCursor"
    >
  > => {
    const result = await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .paginate(args.paginationOpts);

    return {
      page: result.page.map((workspace) => workspace._id),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** Add usage core measured to the account's meter. Unknown ids are dropped. */
export const record = internalMutation({
  args: {
    accountId: v.string(),
    usage: v.object({
      hostedMcpGbSeconds: v.optional(usageQuantityFields.hostedMcpGbSeconds),
      hostedMcpRequests: v.optional(usageQuantityFields.hostedMcpRequests),
      storageGbMonths: v.optional(usageQuantityFields.storageGbMonths),
      egressGb: v.optional(usageQuantityFields.egressGb),
    }),
    /** When the usage happened, if not now; picks the meter month. */
    at: v.optional(v.number()),
    /** Same on every retry of one write, so a retry is applied once. */
    writeId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    if (!accountId) return null;
    const now = Date.now();
    if (args.writeId !== undefined) {
      const writeId = args.writeId;
      const applied = await ctx.db
        .query("usageWrites")
        .withIndex("by_writeId", (q) => q.eq("writeId", writeId))
        .first();
      if (applied) return null;
      await ctx.db.insert("usageWrites", { writeId: writeId, createdAt: now });
    }
    await addUsage(ctx, accountId, args.usage, args.at ?? now);

    return null;
  },
});

/** Daily cron: forget write ids older than a day, one bounded batch per run. */
export const pruneUsageWrites = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const expired = await ctx.db
      .query("usageWrites")
      .withIndex("by_createdAt", (q) =>
        q.lt("createdAt", Date.now() - USAGE_WRITE_RETENTION_MS),
      )
      .take(USAGE_WRITE_PRUNE_BATCH);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
    if (expired.length === USAGE_WRITE_PRUNE_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.account.budget.pruneUsageWrites,
        {},
      );
    }

    return null;
  },
});
