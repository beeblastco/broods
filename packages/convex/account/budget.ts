/**
 * The monthly compute budget, as core and the dashboard reach it: core reads
 * the budget at admission, records the usage only it sees (hosted-MCP invokes,
 * media egress) and claims the 80% warning; the dashboard reads used/limit.
 * Sandbox time is metered by the sandbox mirror itself; storage by the daily
 * snapshot in `aws/storageMeter.ts`. Math lives in `model/usageMeter.ts`.
 */

import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { authKit } from "../auth";
import {
  addUsage,
  budgetStatus,
  claimBudgetWarning,
  type BudgetStatus,
} from "../model/usageMeter";
import { getActiveAccountForUser } from "../org/orgs";
import { planValidator, usageQuantityFields } from "../schema";

const budgetStatusValidator = v.object({
  enforced: v.boolean(),
  plan: planValidator,
  month: v.string(),
  usedEur: v.number(),
  limitEur: v.number(),
  runsPerMinute: v.number(),
  warned: v.boolean(),
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

/** Dashboard billing panel: the active org's budget this month. */
export const getForActiveOrg = query({
  args: {},
  returns: v.union(budgetStatusValidator, v.null()),
  handler: async (ctx): Promise<BudgetStatus | null> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx);

    return account ? await budgetStatus(ctx, account._id, Date.now()) : null;
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
  args: { accountId: v.id("accounts") },
  returns: v.array(v.id("workspaceConfigs")),
  handler: async (ctx, args): Promise<Id<"workspaceConfigs">[]> => {
    const workspaces = await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .take(1000);

    return workspaces.map((workspace) => workspace._id);
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
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    if (accountId) await addUsage(ctx, accountId, args.usage, Date.now());

    return null;
  },
});
