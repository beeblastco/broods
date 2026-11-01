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
import { getActiveCaller } from "../org/orgs";
import { planValidator, usageQuantityFields } from "../schema";

// Core's retries end within a minute; a day of ids is ample.
const USAGE_WRITE_RETENTION_MS = 24 * 60 * 60 * 1000;
const USAGE_WRITE_PRUNE_BATCH = 500;

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

const poolUsageValidator = v.object({
  orgs: v.optional(v.number()),
  shared: v.boolean(),
  totals: usageAmountsValidator,
});

const budgetUsageValidator = v.object({
  enforced: v.boolean(),
  plan: planValidator,
  month: v.string(),
  months: v.array(v.string()),
  usedPercent: v.union(v.number(), v.null()),
  caps: v.union(resourceCapsValidator, v.null()),
  shares: resourceCapsValidator,
  orgShares: resourceCapsValidator,
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
  pool: v.optional(poolUsageValidator),
});

const usageSourceValidator = v.object({
  projectId: v.optional(v.string()),
  agentId: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
});

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

// Null (an unknown id) reads as unlimited at core's admission check.
export const get = internalQuery({
  args: { accountId: v.string() },
  returns: v.union(budgetStatusValidator, v.null()),
  handler: async (ctx, args): Promise<BudgetStatus | null> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);

    return accountId ? await budgetStatus(ctx, accountId, Date.now()) : null;
  },
});

// Euro figures never leave the backend. A non-owner learns the pool is shared, not by how
// many of the owner's orgs.
export const getForActiveOrg = query({
  args: {
    month: v.optional(v.string()),
    withProjects: v.optional(v.boolean()),
  },
  returns: v.union(budgetUsageValidator, v.null()),
  handler: async (ctx, args): Promise<BudgetUsage | null> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const active = await getActiveCaller(ctx);
    if (!active) return null;
    const account = active.account;
    const usage = await budgetUsage(ctx, account._id, Date.now(), args.month);
    if (usage.pool && active.role !== "owner") delete usage.pool.orgs;

    return args.withProjects === true
      ? { ...usage, projects: await projectUsage(ctx, account, usage) }
      : usage;
  },
});

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

// Unknown or deleted accounts drop the write, so a late one never re-creates purged rows.
export const record = internalMutation({
  args: {
    accountId: v.string(),
    usage: v.object({
      hostedMcpGbSeconds: v.optional(usageQuantityFields.hostedMcpGbSeconds),
      hostedMcpRequests: v.optional(usageQuantityFields.hostedMcpRequests),
      workerMs: v.optional(usageQuantityFields.workerMs),
      workerRequests: v.optional(usageQuantityFields.workerRequests),
      storageGbMonths: v.optional(usageQuantityFields.storageGbMonths),
      egressGb: v.optional(usageQuantityFields.egressGb),
      ingressGb: v.optional(usageQuantityFields.ingressGb),
    }),
    at: v.optional(v.number()),
    writeId: v.optional(v.string()),
    source: v.optional(usageSourceValidator),
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

async function usageProject(
  ctx: QueryCtx,
  account: Doc<"accounts">,
  source: Infer<typeof usageSourceValidator>,
): Promise<Id<"projects"> | undefined> {
  let projectId: Id<"projects"> | null | undefined;
  if (source.projectId !== undefined) {
    projectId = ctx.db.normalizeId("projects", source.projectId);
  } else if (source.agentId !== undefined) {
    const agentId = ctx.db.normalizeId("agents", source.agentId);
    const agent = agentId ? await ctx.db.get(agentId) : null;
    // Any of the agent's configs will do: all its stages sit in one project.
    const config =
      agent?.accountId === account._id
        ? await ctx.db
            .query("agentConfigs")
            .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
            .first()
        : null;
    projectId = config?.projectId;
  } else if (source.workspaceId !== undefined) {
    const workspaceId = ctx.db.normalizeId(
      "workspaceConfigs",
      source.workspaceId,
    );
    const workspace = workspaceId ? await ctx.db.get(workspaceId) : null;
    projectId =
      workspace?.accountId === account._id ? workspace.projectId : undefined;
  }
  const project = projectId ? await ctx.db.get(projectId) : null;

  return project?.orgId === account.orgId ? project._id : undefined;
}
