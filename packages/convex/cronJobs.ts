/**
 * Cron job CRUD scoped to an account. Mirrors filthy-panty's
 * functions/_shared/cron-jobs.ts so the SaaS dashboard can drive the same
 * lifecycle through Convex live queries. The AWS EventBridge Scheduler
 * names (`schedulerName`, `schedulerGroupName`) are stored here for
 * visibility; the Lambda is still responsible for the actual EBS calls.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { cronJobsFields } from "./schema";

const cronJobDoc = v.object({
    ...cronJobsFields,
    _id: v.id("cronJobs"),
    _creationTime: v.number(),
});

const cronJobStatusValidator = v.union(
    v.literal("active"),
    v.literal("paused"),
);

const cronJobLastStatusValidator = v.union(
    v.literal("started"),
    v.literal("completed"),
    v.literal("failed"),
);

/** Returns a cron job only when it belongs to the supplied account. */
export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
    },
    returns: v.union(cronJobDoc, v.null()),
    handler: async (ctx, args) => {
        const { accountId, cronJobId } = args;
        const cronJob = await ctx.db.get(cronJobId);
        if (!cronJob || cronJob.accountId !== accountId) {
            return null;
        }

        return cronJob;
    },
});

/** Lists every cron job owned by the supplied account. */
export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(cronJobDoc),
    handler: async (ctx, args) => {
        const { accountId } = args;
        const cronJobs = await ctx.db
            .query("cronJobs")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();

        return cronJobs;
    },
});

/** Lists cron jobs filtered by status (e.g. only `active` ones). */
export const listByStatus = internalQuery({
    args: {
        accountId: v.id("accounts"),
        status: cronJobStatusValidator,
    },
    returns: v.array(cronJobDoc),
    handler: async (ctx, args) => {
        const { accountId, status } = args;
        const cronJobs = await ctx.db
            .query("cronJobs")
            .withIndex("by_accountId_and_status", (q) =>
                q.eq("accountId", accountId).eq("status", status),
            )
            .collect();

        return cronJobs;
    },
});

/** Lookup helper for EBS callbacks; resolves a schedulerName to its row. */
export const getBySchedulerName = internalQuery({
    args: { schedulerName: v.string() },
    returns: v.union(cronJobDoc, v.null()),
    handler: async (ctx, args) => {
        const { schedulerName } = args;
        const cronJob = await ctx.db
            .query("cronJobs")
            .withIndex("by_schedulerName", (q) =>
                q.eq("schedulerName", schedulerName),
            )
            .unique();

        return cronJob ?? null;
    },
});

/** Creates a cron job owned by the supplied account and agent. */
export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        name: v.string(),
        description: v.optional(v.string()),
        agentId: v.id("agents"),
        prompt: v.string(),
        conversationKey: v.optional(v.string()),
        scheduleExpression: v.string(),
        timezone: v.optional(v.string()),
        status: v.optional(cronJobStatusValidator),
        schedulerName: v.string(),
        schedulerGroupName: v.string(),
    },
    returns: v.id("cronJobs"),
    handler: async (ctx, args) => {
        const {
            accountId,
            name,
            description,
            agentId,
            prompt,
            conversationKey,
            scheduleExpression,
            timezone,
            status,
            schedulerName,
            schedulerGroupName,
        } = args;

        const agent = await ctx.db.get(agentId);
        if (!agent || agent.accountId !== accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }

        const now = Date.now();
        const cronJobId = await ctx.db.insert("cronJobs", {
            accountId: accountId,
            name: name,
            description: description,
            agentId: agentId,
            prompt: prompt,
            conversationKey: conversationKey,
            scheduleExpression: scheduleExpression,
            timezone: timezone,
            status: status ?? "active",
            schedulerName: schedulerName,
            schedulerGroupName: schedulerGroupName,
            lastInvokedAt: undefined,
            lastStatus: undefined,
            lastError: undefined,
            createdAt: now,
            updatedAt: now,
        });

        return cronJobId;
    },
});

/** Patches cron-job fields after verifying account ownership. */
export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        name: v.optional(v.string()),
        description: v.optional(v.string()),
        agentId: v.optional(v.id("agents")),
        prompt: v.optional(v.string()),
        conversationKey: v.optional(v.string()),
        scheduleExpression: v.optional(v.string()),
        timezone: v.optional(v.string()),
        status: v.optional(cronJobStatusValidator),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const {
            accountId,
            cronJobId,
            name,
            description,
            agentId,
            prompt,
            conversationKey,
            scheduleExpression,
            timezone,
            status,
        } = args;

        const cronJob = await ctx.db.get(cronJobId);
        if (!cronJob || cronJob.accountId !== accountId) {
            throw new Error(
                "Cron job does not belong to the supplied accountId",
            );
        }

        if (agentId !== undefined) {
            const agent = await ctx.db.get(agentId);
            if (!agent || agent.accountId !== accountId) {
                throw new Error("Agent does not belong to the supplied accountId");
            }
        }

        await ctx.db.patch(cronJobId, {
            ...(name !== undefined ? { name: name } : {}),
            ...(description !== undefined ? { description: description } : {}),
            ...(agentId !== undefined ? { agentId: agentId } : {}),
            ...(prompt !== undefined ? { prompt: prompt } : {}),
            ...(conversationKey !== undefined
                ? { conversationKey: conversationKey }
                : {}),
            ...(scheduleExpression !== undefined
                ? { scheduleExpression: scheduleExpression }
                : {}),
            ...(timezone !== undefined ? { timezone: timezone } : {}),
            ...(status !== undefined ? { status: status } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});

/**
 * Records the result of an invocation. Called by filthy-panty Lambda when an
 * EBS event fires; status transitions are: undefined -> started -> completed | failed.
 */
export const recordInvocation = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
        lastStatus: cronJobLastStatusValidator,
        lastError: v.optional(v.string()),
        lastInvokedAt: v.optional(v.number()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, cronJobId, lastStatus, lastError, lastInvokedAt } =
            args;

        const cronJob = await ctx.db.get(cronJobId);
        if (!cronJob || cronJob.accountId !== accountId) {
            throw new Error(
                "Cron job does not belong to the supplied accountId",
            );
        }

        await ctx.db.patch(cronJobId, {
            lastStatus: lastStatus,
            lastError: lastError,
            lastInvokedAt: lastInvokedAt ?? Date.now(),
            updatedAt: Date.now(),
        });

        return null;
    },
});

/** Removes a cron job after verifying account ownership. */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, cronJobId } = args;
        const cronJob = await ctx.db.get(cronJobId);
        if (!cronJob || cronJob.accountId !== accountId) {
            return null;
        }
        await ctx.db.delete(cronJobId);

        return null;
    },
});
