// Account cron jobs, not the root `crons.ts` platform registry. A row and its schedule are
// written in one transaction, so neither can orphan the other.

import { v, type Infer } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { internal } from "../_generated/api";
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
import { actorsOf, actorValidator } from "../model/actor";
import { accountIdForProject } from "../model/auditEvents";
import {
  normalizeCreateCronInput,
  normalizeUpdateCronInput,
} from "../model/cronRules";
import {
  deleteCron,
  deleteRegistrationIfExists,
  registerSchedule,
  unregisterSchedule,
} from "../model/cronSchedules";
import { getProjectForRole } from "../model/ownership/project";
import {
  agentInProject,
  cronsInProject,
  resourceStageScope,
} from "../model/projectScope";
import { toCronResponse } from "../model/responses";
import { serviceEnv, serviceHeaders } from "../model/serviceBridge";
import { cronRunsFields, cronsFields, paginationCursorFields } from "../schema";
import { ClientError } from "../model/clientError";

const CRON_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CRON_RUN_PAGE_WINDOW = 1000;
const DASHBOARD_RUN_LIMIT = 20;
const PRUNE_BATCH_SIZE = 100;

const cronDoc = v.object({
  ...cronsFields,
  _id: v.id("crons"),
  _creationTime: v.number(),
});

const projectCronDoc = v.object({
  ...cronDoc.omit("lastRunId").fields,
  creator: v.optional(actorValidator),
});
type ProjectCron = Infer<typeof projectCronDoc>;

const cronRunDoc = v.object({
  ...cronRunsFields,
  _id: v.id("cronRuns"),
  _creationTime: v.number(),
});

type Ctx = QueryCtx | MutationCtx;

export const completeRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    runId: v.id("cronRuns"),
    result: v.any(),
  },
  returns: v.null(),
  handler: (ctx, args): Promise<null> =>
    settleRun(ctx, args, { status: "completed", result: args.result }),
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    input: v.record(v.string(), v.any()),
    createdBy: v.optional(v.id("users")),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const normalized = normalizeCreateCronInput(args.input);
    const agent = await getOwnedAgent(ctx, args.accountId, normalized.agentId);

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
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(cronId);
    if (!created) throw new Error("Failed to fetch created cron job");
    const scheduledRunId = await registerSchedule(ctx, created, {
      onPastAt: "throw",
    });
    if (scheduledRunId !== undefined) {
      await ctx.db.patch(cronId, { scheduledRunId: scheduledRunId });
    }

    return toCronResponse(created);
  },
});

export const createRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    eventId: v.string(),
    conversationKey: v.string(),
    firedAt: v.number(),
  },
  returns: v.id("cronRuns"),
  handler: async (ctx, { firedAt, ...args }): Promise<Id<"cronRuns">> => {
    const cron = await getOwned(ctx, args.accountId, args.cronId);
    if (!cron) {
      throw new ClientError(
        "Cron job does not belong to the supplied accountId",
      );
    }

    const startedAt = Date.now();
    const runId = await ctx.db.insert("cronRuns", {
      ...args,
      status: "started",
      startedAt: startedAt,
    });
    if (isLatestFire(cron, firedAt)) {
      await ctx.db.patch(cron._id, {
        lastRunId: runId,
        lastStatus: "started",
        lastError: undefined,
        lastInvokedAt: firedAt,
        updatedAt: startedAt,
      });
    }

    return runId;
  },
});

// Posts to core's in-cluster leaf: the gateway 404s /v1/cron-runs.
export const dispatch = internalAction({
  args: { accountId: v.id("accounts"), cronId: v.id("crons") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const live = await ctx.runQuery(internal.agent.crons.isLive, {
      accountId: args.accountId,
      cronId: args.cronId,
    });
    if (!live) {
      // The row is gone: retire the schedule rather than fire at a deleted job forever.
      await deleteRegistrationIfExists(ctx, args.cronId);

      return null;
    }

    const service = serviceEnv();
    const response = await fetch(`${service.url}/v1/cron-runs`, {
      method: "POST",
      headers: serviceHeaders(args.accountId, service.secret),
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

export const failRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    runId: v.id("cronRuns"),
    error: v.string(),
  },
  returns: v.null(),
  handler: (ctx, args): Promise<null> =>
    settleRun(ctx, args, { status: "failed", error: args.error }),
});

export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.union(cronDoc, v.null()),
  handler: (ctx, { accountId, cronId }): Promise<Doc<"crons"> | null> =>
    getOwned(ctx, accountId, cronId),
});

export const isLive = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.boolean(),
  handler: async (ctx, { accountId, cronId }): Promise<boolean> =>
    (await getOwned(ctx, accountId, cronId)) !== null,
});

export const list = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.optional(v.id("agents")),
  },
  returns: v.array(cronDoc),
  handler: (ctx, { accountId, agentId }): Promise<Doc<"crons">[]> =>
    agentId
      ? ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId).eq("agentId", agentId),
          )
          .collect()
      : ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId),
          )
          .collect(),
});

export const listPage = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.optional(v.id("agents")),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({ page: v.array(cronDoc), ...paginationCursorFields }),
  handler: (
    ctx,
    { accountId, agentId, paginationOpts },
  ): Promise<PaginationResult<Doc<"crons">>> =>
    agentId
      ? ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId).eq("agentId", agentId),
          )
          .paginate(paginationOpts)
      : ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId),
          )
          .paginate(paginationOpts),
});

export const listForProject = query({
  args: { projectId: v.id("projects") },
  returns: v.array(projectCronDoc),
  handler: async (ctx, args): Promise<ProjectCron[]> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, args.projectId);
    if (!project) return [];

    const accountId = await accountIdForProject(ctx, args.projectId);
    if (!accountId) return [];

    const crons = await cronsInProject(ctx, args.projectId, accountId);
    const creators = await actorsOf(
      ctx,
      crons.map((cron) => cron.createdBy),
    );

    return crons.map(({ lastRunId: _lastRunId, ...cron }) => ({
      ...cron,
      creator: cron.createdBy ? creators.get(cron.createdBy) : undefined,
    }));
  },
});

export const listRunsForProject = query({
  args: { projectId: v.id("projects"), cronId: v.id("crons") },
  returns: v.array(cronRunDoc.omit("result")),
  handler: async (ctx, args): Promise<Omit<Doc<"cronRuns">, "result">[]> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const project = await getProjectForRole(ctx, user.id, args.projectId);
    if (!project) return [];
    const accountId = await accountIdForProject(ctx, args.projectId);
    if (!accountId) return [];
    const cron = await getOwned(ctx, accountId, args.cronId);
    if (!cron) return [];
    if (!(await agentInProject(ctx, cron.agentId, args.projectId))) return [];

    const runs = await ctx.db
      .query("cronRuns")
      .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
        q.eq("accountId", accountId).eq("cronId", cron._id),
      )
      .order("desc")
      .take(DASHBOARD_RUN_LIMIT);

    return runs.map(({ result: _result, ...run }) => run);
  },
});

export const listRuns = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.array(cronRunDoc),
  handler: async (ctx, { accountId, cronId }): Promise<Doc<"cronRuns">[]> => {
    const cron = await getOwned(ctx, accountId, cronId);
    if (!cron) return [];

    // Capped: a month of a per-minute cron's runs exceeds the per-transaction read limit.
    return await ctx.db
      .query("cronRuns")
      .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
        q.eq("accountId", accountId).eq("cronId", cronId),
      )
      .order("desc")
      .take(CRON_RUN_PAGE_WINDOW);
  },
});

export const listRunsPage = internalQuery({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({ page: v.array(cronRunDoc), ...paginationCursorFields }),
  handler: async (
    ctx,
    { accountId, cronId, paginationOpts },
  ): Promise<PaginationResult<Doc<"cronRuns">>> => {
    const cron = await getOwned(ctx, accountId, cronId);
    if (!cron) return { page: [], isDone: true, continueCursor: "" };

    return await ctx.db
      .query("cronRuns")
      .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
        q.eq("accountId", accountId).eq("cronId", cronId),
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

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

// Clears lastRunId, so an older run that settles later leaves this failure alone.
export const recordFailedFire = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
    error: v.string(),
    firedAt: v.number(),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { accountId, cronId, error, firedAt },
  ): Promise<null> => {
    const cron = await getOwned(ctx, accountId, cronId);
    if (!cron) {
      throw new ClientError(
        "Cron job does not belong to the supplied accountId",
      );
    }

    if (!isLatestFire(cron, firedAt)) return null;
    await ctx.db.patch(cronId, {
      lastRunId: undefined,
      lastStatus: "failed",
      lastError: error,
      lastInvokedAt: firedAt,
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = internalMutation({
  args: { accountId: v.id("accounts"), cronId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const cron = await getOwnedByString(ctx, args.accountId, args.cronId);
    if (!cron) return false;
    await deleteCron(ctx, cron);

    return true;
  },
});

export const removeRunsCascade = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.id("crons"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
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
    cronId: v.string(),
    patch: v.record(v.string(), v.any()),
    pin: v.optional(v.object({ projectId: v.string(), stageId: v.string() })),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown> | null> => {
    const existing = await getOwnedByString(ctx, args.accountId, args.cronId);
    if (!existing) return null;
    const patch = normalizeUpdateCronInput(args.patch);
    if (patch.agentId !== undefined) {
      await getOwnedAgent(ctx, args.accountId, patch.agentId);
      const scope =
        args.pin &&
        (await resourceStageScope(
          ctx,
          args.accountId,
          "agents",
          patch.agentId,
        ));
      if (
        args.pin &&
        (scope?.projectId !== args.pin.projectId ||
          scope.stageId !== args.pin.stageId)
      ) {
        throw new ClientError(
          "Cron job agentId must reference an agent on the role's stage",
        );
      }
    }

    const defined = Object.fromEntries(
      Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, value === null ? undefined : value]),
    );
    const updated: Doc<"crons"> = {
      ...existing,
      ...defined,
      updatedAt: Date.now(),
    };

    // Re-register only on a changed value: a `broods dev` sync resending the same ones
    // must keep a rate(...) job's phase.
    const scheduleChanged =
      updated.scheduleExpression !== existing.scheduleExpression ||
      updated.timezone !== existing.timezone ||
      updated.status !== existing.status;
    if (scheduleChanged) {
      await unregisterSchedule(ctx, existing);
      updated.scheduledRunId = await registerSchedule(ctx, updated, {
        onPastAt:
          updated.scheduleExpression !== existing.scheduleExpression
            ? "throw"
            : "run",
      });
    }
    await ctx.db.patch(existing._id, {
      ...defined,
      updatedAt: updated.updatedAt,
      ...(scheduleChanged ? { scheduledRunId: updated.scheduledRunId } : {}),
    });

    return toCronResponse(updated);
  },
});

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

async function getOwned(
  ctx: Ctx,
  accountId: Id<"accounts">,
  cronId: Id<"crons">,
): Promise<Doc<"crons"> | null> {
  const cron = await ctx.db.get(cronId);

  return cron && cron.accountId === accountId ? cron : null;
}

async function getOwnedAgent(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  agentId: string,
): Promise<Doc<"agents">> {
  const normalized = ctx.db.normalizeId("agents", agentId);
  const agent = normalized ? await ctx.db.get(normalized) : null;
  if (!agent || agent.accountId !== accountId) {
    throw new ClientError("Cron job agentId must reference an existing agent");
  }

  return agent;
}

async function getOwnedByString(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  cronId: string,
): Promise<Doc<"crons"> | null> {
  const normalized = ctx.db.normalizeId("crons", cronId);

  return normalized ? await getOwned(ctx, accountId, normalized) : null;
}

function isLatestFire(cron: Doc<"crons">, firedAt: number): boolean {
  return cron.lastInvokedAt === undefined || firedAt >= cron.lastInvokedAt;
}

async function settleRun(
  ctx: MutationCtx,
  ids: {
    accountId: Id<"accounts">;
    cronId: Id<"crons">;
    runId: Id<"cronRuns">;
  },
  outcome:
    | { status: "completed"; result: unknown }
    | { status: "failed"; error: string },
): Promise<null> {
  const run = await ctx.db.get(ids.runId);
  if (!run) return null;
  if (run.accountId !== ids.accountId || run.cronId !== ids.cronId) {
    throw new ClientError(
      "Cron job run does not belong to the supplied accountId and cronId",
    );
  }
  if (run.status !== "started") return null;
  const now = Date.now();
  await ctx.db.patch(ids.runId, { ...outcome, completedAt: now });
  const cron = await ctx.db.get(ids.cronId);
  if (cron?.lastRunId === ids.runId) {
    await ctx.db.patch(ids.cronId, {
      lastStatus: outcome.status,
      lastError: outcome.status === "failed" ? outcome.error : undefined,
      updatedAt: now,
    });
  }

  return null;
}
