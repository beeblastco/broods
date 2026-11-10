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
  isOneTimeSchedule,
  normalizeCreateCronInput,
  normalizeUpdateCronInput,
} from "../model/cronRules";
import {
  deleteCron,
  deleteRegistrationIfExists,
  deleteRunWaits,
  registerSchedule,
  unregisterSchedule,
} from "../model/cronSchedules";
import { getProjectForRole } from "../model/ownership/project";
import {
  agentInProject,
  cronsInProject,
  resourceStageScope,
} from "../model/projectScope";
import {
  cronResponseValidator,
  toCronResponse,
  type CronResponse,
} from "../model/responses";
import { serviceEnv, serviceHeaders } from "../model/serviceBridge";
import { cronRunsFields, cronsFields, paginationCursorFields } from "../schema";
import { ClientError } from "../model/clientError";

const CRON_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CRON_RUN_PAGE_WINDOW = 1000;
const DASHBOARD_RUN_LIMIT = 20;
const PRUNE_BATCH_SIZE = 100;
// A younger run may not have its envelope yet, or may be about to settle its own row.
const DEAD_RUN_GRACE_MS = 5 * 60 * 1000;
// A worker that outlives its lease on one long step still settles afterwards.
const EXPIRED_RUN_GRACE_MS = 60 * 60 * 1000;
// As long as the polling row that holds the open approval.
const PAUSED_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Rows from before `ingressEventId` have no envelope to read, so only age can end them.
const UNTRACKED_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEAD_RUN_ERROR = "The run stopped before it recorded an outcome.";
const UNANSWERED_RUN_ERROR =
  "The run waited for an approval or an answer that never came.";

type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string };

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
    managedBy: cronsFields.managedBy,
  },
  returns: cronResponseValidator,
  handler: async (ctx, args): Promise<CronResponse> => {
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
      managedBy: args.managedBy,
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
    ingressEventId: v.optional(v.string()),
    ingressConversationKey: v.optional(v.string()),
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
      ...(isOneTimeSchedule(cron.scheduleExpression) ? { oneShot: true } : {}),
      waitingOn: [],
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
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({ page: v.array(cronDoc), ...paginationCursorFields }),
  handler: (
    ctx,
    { accountId, paginationOpts },
  ): Promise<PaginationResult<Doc<"crons">>> =>
    ctx.db
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

// A paused run records what it waits on; the turn that answers one of those ends it, or pauses
// it again on what that turn asked in turn.
export const settleAnsweredRun = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    answered: v.array(v.string()),
    waitingOn: cronRunsFields.waitingOn,
    status: v.union(v.literal("completed"), v.literal("failed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const run =
      args.answered.length > 0
        ? await runWaitingOn(ctx, args.conversationKey, args.answered)
        : await ctx.db
            .query("cronRuns")
            .withIndex("by_ingressEventId", (q) =>
              q.eq("ingressEventId", args.ownerEventId),
            )
            .first();
    if (run?.status !== "started") return null;
    if (args.waitingOn) {
      await deleteRunWaits(ctx, run._id);
      for (const promptId of args.waitingOn) {
        await ctx.db.insert("cronRunWaits", {
          conversationKey: args.conversationKey,
          promptId: promptId,
          runId: run._id,
        });
      }
      await ctx.db.patch(run._id, { waitingOn: args.waitingOn });
    } else {
      await finishRun(
        ctx,
        run,
        args.status === "completed"
          ? { status: "completed", result: args.result ?? null }
          : { status: "failed", error: args.error ?? DEAD_RUN_ERROR },
      );
    }

    return null;
  },
});

// Ends runs a killed pod can no longer settle; `settleRun` lets a real outcome win any race.
// Every page reads up to the same `now`: a cursor is valid only for the query that made it.
export const sweepDeadRuns = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("cronRuns")
      .withIndex("by_status_and_startedAt", (q) =>
        q.eq("status", "started").lt("startedAt", now - DEAD_RUN_GRACE_MS),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: PRUNE_BATCH_SIZE });
    let settled = 0;
    for (const run of page.page) {
      const outcome = await deadRunOutcome(ctx, run, now);
      if (outcome === null) continue;
      await finishRun(ctx, run, outcome);
      settled += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.agent.crons.sweepDeadRuns, {
        now: now,
        cursor: page.continueCursor,
      });
    }

    return settled;
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cronId: v.string(),
    patch: v.record(v.string(), v.any()),
    pin: v.optional(v.object({ projectId: v.string(), stageId: v.string() })),
    /** Set when code declares the job, which adopts one an agent made under that name. */
    managedBy: cronsFields.managedBy,
  },
  returns: v.union(cronResponseValidator, v.null()),
  handler: async (ctx, args): Promise<CronResponse | null> => {
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

    const defined = {
      ...Object.fromEntries(
        Object.entries(patch)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, value === null ? undefined : value]),
      ),
      ...(args.managedBy ? { managedBy: args.managedBy } : {}),
    };
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

// Null while the run may still settle itself, or waits on a person.
async function deadRunOutcome(
  ctx: QueryCtx,
  run: Doc<"cronRuns">,
  now: number,
): Promise<RunOutcome | null> {
  const dead: RunOutcome = { status: "failed", error: DEAD_RUN_ERROR };
  if (run.ingressEventId === undefined) {
    return run.startedAt < now - UNTRACKED_RUN_MAX_AGE_MS ? dead : null;
  }
  const eventId = run.ingressEventId;
  const envelope = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .first();
  if (!envelope) return dead;
  const endedAgo = now - envelope.updatedAt;
  switch (envelope.status) {
    case "completed": {
      const polling = await ctx.db
        .query("runtimeAsyncAgentResults")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .first();
      if (
        polling?.status === "awaiting_approval" ||
        polling?.status === "awaiting_input"
      ) {
        return now - run.startedAt > PAUSED_RUN_MAX_AGE_MS
          ? { status: "failed", error: UNANSWERED_RUN_ERROR }
          : null;
      }

      return endedAgo > DEAD_RUN_GRACE_MS
        ? { status: "completed", result: envelope.result ?? null }
        : null;
    }
    case "failed":
      return endedAgo > DEAD_RUN_GRACE_MS
        ? { status: "failed", error: envelope.error || DEAD_RUN_ERROR }
        : null;
    case "expired":
      return endedAgo > EXPIRED_RUN_GRACE_MS ? dead : null;
    default:
      return null;
  }
}

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
  for (const run of runs) {
    await deleteRunWaits(ctx, run._id);
    await ctx.db.delete(run._id);
  }

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

async function finishRun(
  ctx: MutationCtx,
  run: Doc<"cronRuns">,
  outcome: RunOutcome,
): Promise<void> {
  await settleRun(
    ctx,
    { accountId: run.accountId, cronId: run.cronId, runId: run._id },
    outcome,
  );
  if (run.oneShot) {
    await ctx.scheduler.runAfter(0, internal.agent.crons.remove, {
      accountId: run.accountId,
      cronId: run.cronId,
    });
  }
}

function isLatestFire(cron: Doc<"crons">, firedAt: number): boolean {
  return cron.lastInvokedAt === undefined || firedAt >= cron.lastInvokedAt;
}

async function runWaitingOn(
  ctx: QueryCtx,
  conversationKey: string,
  answered: string[],
): Promise<Doc<"cronRuns"> | null> {
  for (const promptId of answered) {
    const wait = await ctx.db
      .query("cronRunWaits")
      .withIndex("by_conversationKey_and_promptId", (q) =>
        q.eq("conversationKey", conversationKey).eq("promptId", promptId),
      )
      .first();
    const run = wait ? await ctx.db.get(wait.runId) : null;
    if (run?.status === "started") return run;
  }
  // Rows from before `waitingOn` keep the old rule. Delete 7 days after release: swept by then.
  const newest = await ctx.db
    .query("cronRuns")
    .withIndex("by_ingressConversationKey_and_status", (q) =>
      q.eq("ingressConversationKey", conversationKey).eq("status", "started"),
    )
    .order("desc")
    .first();

  return newest?.waitingOn === undefined ? newest : null;
}

async function settleRun(
  ctx: MutationCtx,
  ids: {
    accountId: Id<"accounts">;
    cronId: Id<"crons">;
    runId: Id<"cronRuns">;
  },
  outcome: RunOutcome,
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
  await deleteRunWaits(ctx, ids.runId);
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
