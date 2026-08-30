/**
 * Cron job CRUD scoped to an account, and the schedules that fire them.
 * Mirrors broods's apps/core/src/shared/domain/cron.ts so the SaaS dashboard
 * can drive the same lifecycle through Convex live queries. Recurring jobs are
 * registered with the Convex crons component and one-time at(...) jobs with
 * the Convex scheduler, both in the same transaction as the row write, so a
 * schedule can never orphan the job that names it. Distinct from the root
 * `crons.ts`, which is the Convex platform cron registry.
 */

import { Crons } from "@convex-dev/crons";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authKit } from "../auth";
import { accountIdForProject } from "../model/auditEvents";
import {
  normalizeCreateCronInput,
  normalizeUpdateCronInput,
  translateScheduleExpression,
} from "../model/cronRules";
import { getProjectForRole } from "../model/ownership/project";
import { cronsInProject } from "../model/projectScope";
import { toCronResponse } from "../model/responses";
import { cronRunsFields, cronsFields } from "../schema";

const cronSchedules = new Crons(components.crons);

const CRON_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 100;

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

type Ctx = QueryCtx | MutationCtx;

/**
 * POST one fired cron job to the gateway's /v1/cron-runs leaf, where core
 * starts the configured agent. The crons component (and the Convex scheduler
 * for one-time jobs) invokes this with the same {kind, accountId, cronId}
 * payload EventBridge used to deliver, so core is untouched.
 */
export const dispatch = internalAction({
  args: { accountId: v.id("accounts"), cronId: v.id("crons") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cron = await ctx.runQuery(internal.agent.crons.getById, {
      accountId: args.accountId,
      cronId: args.cronId,
    });
    if (!cron) {
      // The row is gone (a cascade that could not reach the registration, or
      // a crash between the two) — retire the schedule instead of firing it
      // at a deleted job forever.
      if (await cronSchedules.get(ctx, { name: args.cronId })) {
        await cronSchedules.delete(ctx, { name: args.cronId });
      }

      return null;
    }

    const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
    const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
    if (!url || !secret) {
      throw new Error(
        "Cron dispatch requires BROODS_ACCOUNT_MANAGE_URL and BROODS_SERVICE_AUTH_SECRET",
      );
    }
    const response = await fetch(`${url.replace(/\/+$/, "")}/v1/cron-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "cron",
        accountId: args.accountId,
        cronId: args.cronId,
        scheduledTime: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Cron run dispatch failed with status ${response.status}`,
      );
    }

    return null;
  },
});

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

/**
 * Create a cron job: validate the input, insert the crons row, and register
 * its schedule with the crons component (or the Convex scheduler for a
 * one-time at(...) job) in the same transaction — the row and the schedule
 * are one write, so neither can orphan the other.
 * @param accountId account id owning the cron job
 * @param input the create-cron request body
 * @returns the public cron record
 */
export const create = internalMutation({
  args: { accountId: v.id("accounts"), input: v.any() },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const normalized = normalizeCreateCronInput(args.input);
    const agent = await ctx.db.get(normalized.agentId as Id<"agents">);
    if (!agent || agent.accountId !== args.accountId) {
      throw new Error("Cron job agentId must reference an existing agent");
    }

    const now = Date.now();
    const cronId = await ctx.db.insert("crons", {
      accountId: args.accountId,
      name: normalized.name,
      description: normalized.description,
      agentId: agent._id,
      events: normalized.events,
      conversationKey: normalized.conversationKey,
      scheduleExpression: normalized.scheduleExpression,
      timezone: normalized.timezone,
      status: normalized.status ?? "active",
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(cronId);
    if (!created) throw new Error("Failed to fetch created cron job");
    await registerSchedule(ctx, created, { requireFuture: true });
    const registered = await ctx.db.get(cronId);

    return toCronResponse(registered ?? created);
  },
});

/** Creates a cron job run history row when a schedule fires. */
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

/**
 * Delete a cron job and its schedule in one transaction. Run history can
 * exceed one transaction, so a scheduled mutation drains it in bounded
 * batches after this commits.
 * @param accountId account id owning the cron job
 * @param cronId the cron job id
 * @returns true when the job existed and was removed
 */
export const remove = internalMutation({
  args: { accountId: v.id("accounts"), cronId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const cron = await getOwnedByString(ctx, args.accountId, args.cronId);
    if (!cron) return false;
    await unregisterSchedule(ctx, cron);
    await ctx.scheduler.runAfter(0, internal.agent.crons.removeRunsCascade, {
      accountId: cron.accountId,
      cronId: cron._id,
    });
    await ctx.db.delete(cron._id);

    return true;
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

/**
 * Update a cron job: patch the row and replace its registered schedule in the
 * same transaction whenever the schedule, timezone, or status changed.
 * @param accountId account id owning the cron job
 * @param cronId the cron job id
 * @param patch the update-cron request body
 * @returns the refreshed public cron record, or null when the job is missing
 */
export const update = internalMutation({
  args: { accountId: v.id("accounts"), cronId: v.string(), patch: v.any() },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown> | null> => {
    const existing = await getOwnedByString(ctx, args.accountId, args.cronId);
    if (!existing) return null;
    const patch = normalizeUpdateCronInput(args.patch);
    if (patch.agentId !== undefined) {
      const agent = await ctx.db.get(patch.agentId as Id<"agents">);
      if (!agent || agent.accountId !== args.accountId) {
        throw new Error("Cron job agentId must reference an existing agent");
      }
    }

    const defined = Object.fromEntries(
      Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, value === null ? undefined : value]),
    );
    await ctx.db.patch(existing._id, { ...defined, updatedAt: Date.now() });
    const updated = await ctx.db.get(existing._id);
    if (!updated) return null;

    // The registration encodes the schedule, timezone, and active state, so a
    // patch touching any of them replaces it; other fields leave it alone.
    if (
      patch.scheduleExpression !== undefined ||
      patch.timezone !== undefined ||
      patch.status !== undefined
    ) {
      await unregisterSchedule(ctx, updated);
      if (updated.status === "active") {
        await registerSchedule(ctx, updated, {
          requireFuture: patch.scheduleExpression !== undefined,
        });
      }
    }
    const registered = await ctx.db.get(existing._id);

    return toCronResponse(registered ?? updated);
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

/** Like getOwned, treating a malformed id string as missing. */
async function getOwnedByString(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  cronId: string,
): Promise<Doc<"crons"> | null> {
  const normalized = ctx.db.normalizeId("crons", cronId);

  return normalized ? await getOwned(ctx, accountId, normalized) : null;
}

/**
 * Register the schedule that fires one cron job. Recurring schedules become a
 * crons-component registration named by the row id; a one-time at(...) job
 * becomes a Convex scheduler run whose id the row records for cancellation.
 */
async function registerSchedule(
  ctx: MutationCtx,
  cron: Doc<"crons">,
  options: { requireFuture: boolean },
): Promise<void> {
  const schedule = translateScheduleExpression(
    cron.scheduleExpression,
    cron.timezone,
  );
  if (schedule.kind !== "at") {
    await cronSchedules.register(
      ctx,
      schedule,
      internal.agent.crons.dispatch,
      { accountId: cron.accountId, cronId: cron._id },
      cron._id,
    );

    return;
  }
  if (options.requireFuture && schedule.timestamp <= Date.now()) {
    throw new Error("at(...) time must be in the future");
  }
  const scheduledRunId = await ctx.scheduler.runAt(
    schedule.timestamp,
    internal.agent.crons.dispatch,
    { accountId: cron.accountId, cronId: cron._id },
  );
  await ctx.db.patch(cron._id, { scheduledRunId: scheduledRunId });
}

/** Deschedule whatever fires this cron job; a missing schedule is done. */
async function unregisterSchedule(
  ctx: MutationCtx,
  cron: Doc<"crons">,
): Promise<void> {
  if (cron.scheduledRunId) {
    await ctx.scheduler.cancel(cron.scheduledRunId);
    await ctx.db.patch(cron._id, { scheduledRunId: undefined });
  }
  if (await cronSchedules.get(ctx, { name: cron._id })) {
    await cronSchedules.delete(ctx, { name: cron._id });
  }
}
