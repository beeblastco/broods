/**
 * Cron job CRUD scoped to an account. Mirrors broods's
 * apps/core/src/shared/domain/cron.ts so the SaaS dashboard can drive the
 * same lifecycle through Convex live queries. The AWS EventBridge Scheduler
 * names are stored here for visibility; the Lambda invokes EBS. Distinct from
 * the root `crons.ts`, which is the Convex platform cron registry.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authKit } from "../auth";
import { accountIdForProject } from "../model/auditEvents";
import { getProjectForRole } from "../model/ownership/project";
import { cronsInProject } from "../model/projectScope";
import { cronRunsFields, cronsFields } from "../schema";

const CRON_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 100;

const clearableCronStringValidator = v.optional(v.union(v.string(), v.null()));

const cronDoc = v.object({
  ...cronsFields,
  _id: v.id("crons"),
  _creationTime: v.number(),
});

const cronLastStatusValidator = v.union(
  v.literal("started"),
  v.literal("completed"),
  v.literal("failed"),
);

const cronRunDoc = v.object({
  ...cronRunsFields,
  _id: v.id("cronRuns"),
  _creationTime: v.number(),
});

const cronStatusValidator = v.union(v.literal("active"), v.literal("paused"));
const optionalCronStringValidator = v.optional(v.string());

type Ctx = QueryCtx | MutationCtx;

/** Marks a cron job run complete and stores the final model result. */
export const completeRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    runId: v.id("cronRuns"),
    result: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, cronId, runId, result }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.accountId !== accountId || run.cronId !== cronId) {
      throw new Error(
        "Cron job run does not belong to the supplied accountId and cronId",
      );
    }

    await ctx.db.patch(runId, {
      status: "completed",
      result: result,
      completedAt: Date.now(),
    });

    return null;
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    description: optionalCronStringValidator,
    agentId: v.id("agents"),
    events: v.array(v.any()),
    conversationKey: optionalCronStringValidator,
    scheduleExpression: v.string(),
    timezone: optionalCronStringValidator,
    status: v.optional(cronStatusValidator),
    schedulerName: v.string(),
    schedulerGroupName: v.string(),
  },
  returns: v.id("crons"),
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.accountId !== args.accountId) {
      throw new Error("Agent does not belong to the supplied accountId");
    }

    const now = Date.now();

    return ctx.db.insert("crons", {
      ...args,
      status: args.status ?? "active",
      lastInvokedAt: undefined,
      lastStatus: undefined,
      lastError: undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Creates a cron job run history row when EventBridge invokes a schedule. */
export const createRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    eventId: v.string(),
    conversationKey: v.string(),
  },
  returns: v.id("cronRuns"),
  handler: async (ctx, args) => {
    const cron = await getOwned(ctx, args.accountId, args.cronId);
    if (!cron) {
      throw new Error("Cron job does not belong to the supplied accountId");
    }

    return await ctx.db.insert("cronRuns", {
      ...args,
      status: "started",
      startedAt: Date.now(),
    });
  },
});

/** Marks a cron job run failed and stores the error. */
export const failRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    runId: v.id("cronRuns"),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, cronId, runId, error }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.accountId !== accountId || run.cronId !== cronId) {
      throw new Error(
        "Cron job run does not belong to the supplied accountId and cronId",
      );
    }

    await ctx.db.patch(runId, {
      status: "failed",
      error: error,
      completedAt: Date.now(),
    });

    return null;
  },
});

export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.union(cronDoc, v.null()),
  handler: (ctx, { accountId, cronId }) => getOwned(ctx, accountId, cronId),
});

/** Every cron job of an account, or only one agent's when `agentId` is given. */
export const list = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.optional(v.id("agents")),
  },
  returns: v.array(cronDoc),
  handler: (ctx, { accountId, agentId }) =>
    agentId
      ? ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId).eq("agentId", agentId),
          )
          .collect()
      : ctx.db
          .query("crons")
          .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
          .collect(),
});

/**
 * Lists the cron jobs whose agent belongs to `projectId`, for that project's
 * scheduler page.
 *
 * A cron has no projectId of its own — it points at an agent, and the agent's
 * project comes from `agentConfigs`. Deriving it rather than storing a copy is
 * what keeps a cron from ever claiming a different project than the agent it
 * actually runs. Crons whose agent has no config row belong to no project and
 * are absent here.
 * @param projectId the project to list cron jobs for
 */
export const listForProject = query({
  args: { projectId: v.id("projects") },
  returns: v.array(cronDoc),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, args.projectId);
    if (!project) return [];

    const accountId = await accountIdForProject(ctx, args.projectId);
    if (!accountId) return [];

    return await cronsInProject(ctx, args.projectId, accountId);
  },
});

/** Lists recent cron job runs newest-first for account-management APIs. */
export const listRuns = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    limit: v.optional(v.number()),
  },
  returns: v.array(cronRunDoc),
  handler: async (ctx, { accountId, cronId, limit }) => {
    const cron = await getOwned(ctx, accountId, cronId);
    if (!cron) return [];

    return await ctx.db
      .query("cronRuns")
      .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
        q.eq("accountId", accountId).eq("cronId", cronId),
      )
      .order("desc")
      .take(limit ?? 20);
  },
});

/**
 * Deletes cron run history older than the retention window, one bounded batch
 * per invocation. Run rows carry the full model result, and `listRuns` only
 * ever shows the newest handful, so old rows are pure storage growth. The
 * creation-index range reads nothing when nothing is due.
 */
export const pruneExpiredRuns = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - CRON_RUN_RETENTION_MS;
    const rows = await ctx.db
      .query("cronRuns")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(PRUNE_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PRUNE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.agent.crons.pruneExpiredRuns,
        {},
      );
    }

    return rows.length;
  },
});

/**
 * Records the result of an invocation. Status transitions:
 * undefined -> started -> completed | failed.
 */
export const recordInvocation = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    lastStatus: cronLastStatusValidator,
    lastError: v.optional(v.string()),
    lastInvokedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { accountId, cronId, lastStatus, lastError, lastInvokedAt },
  ) => {
    const cron = await getOwned(ctx, accountId, cronId);
    if (!cron) {
      throw new Error("Cron job does not belong to the supplied accountId");
    }

    await ctx.db.patch(cronId, {
      lastStatus: lastStatus,
      lastError: lastError,
      lastInvokedAt: lastInvokedAt ?? Date.now(),
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, cronId }) => {
    const cron = await getOwned(ctx, accountId, cronId);
    if (cron) await ctx.db.delete(cronId);

    return null;
  },
});

/**
 * Deletes one bounded batch of a cron job's run history. The caller repeats
 * until it returns less than `limit`, so a long-lived job's history never has
 * to fit in a single transaction.
 */
export const removeRuns = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    limit: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, { accountId, cronId, limit }) => {
    return await deleteRunsBatch(ctx, accountId, cronId, limit);
  },
});

/**
 * Drains a deleted cron's run history: deletes one bounded batch per
 * invocation and reschedules itself until none remain. Scheduled by
 * `purgeProject`, which deletes the cron row in its own transaction; run rows
 * stay reachable through the account+cron index prefix.
 */
export const removeRunsCascade = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deleted = await deleteRunsBatch(
      ctx,
      args.accountId,
      args.cronId,
      PRUNE_BATCH_SIZE,
    );
    if (deleted === PRUNE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.agent.crons.removeRunsCascade, {
        accountId: args.accountId,
        cronId: args.cronId,
      });
    }

    return null;
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    name: v.optional(v.string()),
    description: clearableCronStringValidator,
    agentId: v.optional(v.id("agents")),
    events: v.optional(v.array(v.any())),
    conversationKey: clearableCronStringValidator,
    scheduleExpression: v.optional(v.string()),
    timezone: clearableCronStringValidator,
    status: v.optional(cronStatusValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { accountId, cronId, agentId, ...patch } = args;

    const cron = await getOwned(ctx, accountId, cronId);
    if (!cron) {
      throw new Error("Cron job does not belong to the supplied accountId");
    }

    if (agentId !== undefined) {
      const agent = await ctx.db.get(agentId);
      if (!agent || agent.accountId !== accountId) {
        throw new Error("Agent does not belong to the supplied accountId");
      }
    }

    const defined = Object.fromEntries(
      Object.entries({ ...patch, agentId: agentId })
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => [key, value === null ? undefined : value]),
    );

    await ctx.db.patch(cronId, { ...defined, updatedAt: Date.now() });

    return null;
  },
});

/** Deletes up to `limit` run rows of one cron, returning how many went. */
async function deleteRunsBatch(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  cronId: Id<"crons">,
  limit: number,
): Promise<number> {
  const runs = await ctx.db
    .query("cronRuns")
    .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
      q.eq("accountId", accountId).eq("cronId", cronId),
    )
    .take(limit);
  for (const run of runs) await ctx.db.delete(run._id);

  return runs.length;
}

/** Loads a cron job only when it belongs to the supplied account. */
async function getOwned(
  ctx: Ctx,
  accountId: Id<"accounts">,
  cronId: Id<"crons">,
): Promise<Doc<"crons"> | null> {
  const cron = await ctx.db.get(cronId);

  return cron && cron.accountId === accountId ? cron : null;
}
