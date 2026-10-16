/**
 * The monthly resource caps, as core and the dashboard reach them: core reads
 * the closest cap's share at admission, records the usage only it sees
 * (hosted-MCP invokes, media egress, attachment ingress) and claims the 80%
 * warning; the dashboard reads amounts, caps and percentages.
 * Sandbox time is metered by the sandbox mirror itself; storage by the daily
 * snapshot in `aws/storageMeter.ts`. Math lives in `model/usageMeter.ts`.
 */

import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "../_generated/server";
import { authKit } from "../auth";
import {
  addProjectUsage,
  addUsage,
  budgetStatus,
  budgetUsage,
  claimBudgetWarning,
  projectUsage,
  type BudgetStatus,
  type BudgetUsage,
} from "../model/usageMeter";
import { resourceStageScope } from "../model/projectScope";
import { getActiveAccountForUser } from "../org/orgs";
import { planValidator, usageQuantityFields } from "../schema";

// Core's retries end within a minute; a day of ids is ample.
const USAGE_WRITE_RETENTION_MS = 24 * 60 * 60 * 1000;
const USAGE_WRITE_PRUNE_BATCH = 500;

// Also the shape of each resource's share, keyed like its cap.
const resourceCapsValidator = v.object({
  sandboxHours: v.number(),
  hostedMcpHours: v.number(),
  storageGb: v.number(),
  egressGb: v.number(),
});

const budgetStatusValidator = v.object({
  enforced: v.boolean(),
  plan: planValidator,
  month: v.string(),
  usedPercent: v.number(),
  shares: resourceCapsValidator,
  runsPerMinute: v.number(),
  warned: v.boolean(),
});

const usageAmountsFields = {
  sandboxHours: v.number(),
  hostedMcpHours: v.number(),
  storageGb: v.union(v.number(), v.null()),
  egressGb: v.number(),
  ingressGb: v.number(),
};

const usageAmountsValidator = v.object(usageAmountsFields);

const budgetUsageValidator = v.object({
  enforced: v.boolean(),
  plan: planValidator,
  month: v.string(),
  months: v.array(v.string()),
  usedPercent: v.union(v.number(), v.null()),
  caps: v.union(resourceCapsValidator, v.null()),
  shares: resourceCapsValidator,
  level: v.union(v.literal("ok"), v.literal("warning"), v.literal("exhausted")),
  totals: usageAmountsValidator,
  days: v.array(v.object({ day: v.string(), ...usageAmountsFields })),
  projects: v.optional(
    v.array(
      v.object({
        projectId: v.id("projects"),
        name: v.string(),
        totals: usageAmountsValidator,
        days: v.array(v.object({ day: v.string(), ...usageAmountsFields })),
      }),
    ),
  ),
});

// Where a usage write came from, as far as the writer knows.
const usageSourceValidator = v.object({
  projectId: v.optional(v.string()),
  agentId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
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
 * Dashboard allowance and billing plan: the active org's usage for `month`
 * ("YYYY-MM", one of the returned `months`; anything else reads the current
 * month) as amounts, days, caps and percentages, and with `withProjects` each
 * of the org's projects' part of that month. Euro figures never leave the
 * backend, so the plan budgets stay private.
 */
export const getForActiveOrg = query({
  args: {
    month: v.optional(v.string()),
    withProjects: v.optional(v.boolean()),
  },
  returns: v.union(budgetUsageValidator, v.null()),
  handler: async (ctx, args): Promise<BudgetUsage | null> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx);
    if (!account) return null;
    const usage = await budgetUsage(ctx, account._id, Date.now(), args.month);

    return args.withProjects === true
      ? { ...usage, projects: await projectUsage(ctx, account, usage) }
      : usage;
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

/**
 * The account's workspaces, whose S3 namespaces the storage snapshot sums,
 * with the project each belongs to (none for an account-wide one).
 */
export const listWorkspaces = internalQuery({
  args: {
    accountId: v.id("accounts"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        workspaceId: v.id("workspaceConfigs"),
        projectId: v.optional(v.id("projects")),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<
    Pick<
      PaginationResult<{
        workspaceId: Id<"workspaceConfigs">;
        projectId?: Id<"projects">;
      }>,
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
      page: result.page.map((workspace) => ({
        workspaceId: workspace._id,
        ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Add usage core measured to the account's meter, and to the project it came
 * from when the write names one, directly or by the agent or workspace that
 * used it. Unknown ids and deleted accounts are dropped, so a late write
 * never re-creates purged rows; a source outside the account counts for the
 * account alone. The storage snapshot also sends each project's share of the
 * size it measured.
 */
export const record = internalMutation({
  args: {
    accountId: v.string(),
    usage: v.object({
      hostedMcpGbSeconds: v.optional(usageQuantityFields.hostedMcpGbSeconds),
      hostedMcpRequests: v.optional(usageQuantityFields.hostedMcpRequests),
      storageGbMonths: v.optional(usageQuantityFields.storageGbMonths),
      egressGb: v.optional(usageQuantityFields.egressGb),
      ingressGb: v.optional(usageQuantityFields.ingressGb),
    }),
    /** When the usage happened, if not now; picks the meter month. */
    at: v.optional(v.number()),
    /** Same on every retry of one write, so a retry is applied once. */
    writeId: v.optional(v.string()),
    source: v.optional(usageSourceValidator),
    /** Storage snapshot only: GB-months of `usage` that each project's workspaces hold. */
    projectStorage: v.optional(
      v.array(
        v.object({
          projectId: v.id("projects"),
          storageGbMonths: v.number(),
        }),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    const account = accountId ? await ctx.db.get(accountId) : null;
    if (!account) return null;
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
    const at = args.at ?? now;
    const projectId = args.source
      ? await usageProject(ctx, account, args.source)
      : undefined;
    await addUsage(ctx, account._id, args.usage, at, projectId);
    for (const share of args.projectStorage ?? []) {
      await addProjectUsage(
        ctx,
        account._id,
        share.projectId,
        { storageGbMonths: share.storageGbMonths },
        at,
      );
    }

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

// The account's project a usage write names, by the first id it carries.
async function usageProject(
  ctx: QueryCtx,
  account: Doc<"accounts">,
  source: Infer<typeof usageSourceValidator>,
): Promise<Id<"projects"> | undefined> {
  if (source.projectId !== undefined) {
    const projectId = ctx.db.normalizeId("projects", source.projectId);
    const project = projectId ? await ctx.db.get(projectId) : null;

    return project?.orgId === account.orgId ? project._id : undefined;
  }
  const scope =
    source.agentId !== undefined
      ? await resourceStageScope(ctx, account._id, "agents", source.agentId)
      : source.workspaceId !== undefined
        ? await resourceStageScope(
            ctx,
            account._id,
            "workspaces",
            source.workspaceId,
          )
        : null;

  return scope?.projectId;
}
