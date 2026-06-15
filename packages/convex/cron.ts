/**
 * Cron job CRUD scoped to an account. Mirrors filthy-panty's
 * functions/_shared/cron.ts so the SaaS dashboard can drive the same
 * lifecycle through Convex live queries. The AWS EventBridge Scheduler
 * names are stored here for visibility; the Lambda invokes EBS.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { authKit } from "./auth";
import { getActiveOrgForUser } from "./model/ownership/org";
import { cronRunsFields, cronsFields } from "./schema";

const cronDoc = v.object({
    ...cronsFields,
    _id: v.id("crons"),
    _creationTime: v.number(),
});

const cronRunDoc = v.object({
    ...cronRunsFields,
    _id: v.id("cronRuns"),
    _creationTime: v.number(),
});

const cronStatusValidator = v.union(v.literal("active"), v.literal("paused"));
const optionalCronStringValidator = v.optional(v.string());
const clearableCronStringValidator = v.optional(v.union(v.string(), v.null()));

const cronLastStatusValidator = v.union(
    v.literal("started"),
    v.literal("completed"),
    v.literal("failed"),
);

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

async function getOwned(ctx: Ctx, accountId: Id<"accounts">, cronId: Id<"crons">) {
    const cron = await ctx.db.get(cronId);
    return cron && cron.accountId === accountId ? cron : null;
}

/**
 * Public query: lists cron jobs for the caller's active org. Used by the
 * crons dashboard page for live updates.
 */
export const listForActiveOrg = query({
    args: {},
    returns: v.array(cronDoc),
    handler: async (ctx) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) return [];

        const org = await getActiveOrgForUser(ctx, user._id);
        if (!org) return [];

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .unique();
        if (!account) return [];

        return await ctx.db
            .query("crons")
            .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
            .collect();
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

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(cronDoc),
    handler: (ctx, { accountId }) =>
        ctx.db
            .query("crons")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect(),
});

export const listByStatus = internalQuery({
    args: {
        accountId: v.id("accounts"),
        status: cronStatusValidator,
    },
    returns: v.array(cronDoc),
    handler: (ctx, { accountId, status }) =>
        ctx.db
            .query("crons")
            .withIndex("by_accountId_and_status", (q) =>
                q.eq("accountId", accountId).eq("status", status),
            )
            .collect(),
});

export const getBySchedulerName = internalQuery({
    args: { schedulerName: v.string() },
    returns: v.union(cronDoc, v.null()),
    handler: async (ctx, { schedulerName }) => {
        const cron = await ctx.db
            .query("crons")
            .withIndex("by_schedulerName", (q) => q.eq("schedulerName", schedulerName))
            .unique();
        return cron ?? null;
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
            Object.entries({ ...patch, agentId })
                .filter(([, v]) => v !== undefined)
                .map(([key, value]) => [key, value === null ? undefined : value]),
        );

        await ctx.db.patch(cronId, { ...defined, updatedAt: Date.now() });
        return null;
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
    handler: async (ctx, { accountId, cronId, lastStatus, lastError, lastInvokedAt }) => {
        const cron = await getOwned(ctx, accountId, cronId);
        if (!cron) {
            throw new Error("Cron job does not belong to the supplied accountId");
        }

        await ctx.db.patch(cronId, {
            lastStatus,
            lastError,
            lastInvokedAt: lastInvokedAt ?? Date.now(),
            updatedAt: Date.now(),
        });
        return null;
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
            throw new Error("Cron job run does not belong to the supplied accountId and cronId");
        }

        await ctx.db.patch(runId, {
            status: "completed",
            result,
            completedAt: Date.now(),
        });

        return null;
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
            throw new Error("Cron job run does not belong to the supplied accountId and cronId");
        }

        await ctx.db.patch(runId, {
            status: "failed",
            error,
            completedAt: Date.now(),
        });

        return null;
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
                q.eq("accountId", accountId).eq("cronId", cronId)
            )
            .order("desc")
            .take(limit ?? 20);
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
