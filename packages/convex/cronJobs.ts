/**
 * Cron job CRUD scoped to an account. Mirrors filthy-panty's
 * functions/_shared/cron-jobs.ts so the SaaS dashboard can drive the same
 * lifecycle through Convex live queries. The AWS EventBridge Scheduler
 * names are stored here for visibility; the Lambda invokes EBS.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { cronJobsFields } from "./schema";

const cronJobDoc = v.object({
    ...cronJobsFields,
    _id: v.id("cronJobs"),
    _creationTime: v.number(),
});

const cronJobStatusValidator = v.union(v.literal("active"), v.literal("paused"));

const cronJobLastStatusValidator = v.union(
    v.literal("started"),
    v.literal("completed"),
    v.literal("failed"),
);

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

async function getOwned(ctx: Ctx, accountId: Id<"accounts">, cronJobId: Id<"cronJobs">) {
    const cronJob = await ctx.db.get(cronJobId);
    return cronJob && cronJob.accountId === accountId ? cronJob : null;
}

export const getById = internalQuery({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
    },
    returns: v.union(cronJobDoc, v.null()),
    handler: (ctx, { accountId, cronJobId }) => getOwned(ctx, accountId, cronJobId),
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(cronJobDoc),
    handler: (ctx, { accountId }) =>
        ctx.db
            .query("cronJobs")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect(),
});

export const listByStatus = internalQuery({
    args: {
        accountId: v.id("accounts"),
        status: cronJobStatusValidator,
    },
    returns: v.array(cronJobDoc),
    handler: (ctx, { accountId, status }) =>
        ctx.db
            .query("cronJobs")
            .withIndex("by_accountId_and_status", (q) =>
                q.eq("accountId", accountId).eq("status", status),
            )
            .collect(),
});

export const getBySchedulerName = internalQuery({
    args: { schedulerName: v.string() },
    returns: v.union(cronJobDoc, v.null()),
    handler: async (ctx, { schedulerName }) => {
        const cronJob = await ctx.db
            .query("cronJobs")
            .withIndex("by_schedulerName", (q) => q.eq("schedulerName", schedulerName))
            .unique();
        return cronJob ?? null;
    },
});

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
        const agent = await ctx.db.get(args.agentId);
        if (!agent || agent.accountId !== args.accountId) {
            throw new Error("Agent does not belong to the supplied accountId");
        }

        const now = Date.now();
        return ctx.db.insert("cronJobs", {
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
        const { accountId, cronJobId, agentId, ...patch } = args;

        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (!cronJob) {
            throw new Error("Cron job does not belong to the supplied accountId");
        }

        if (agentId !== undefined) {
            const agent = await ctx.db.get(agentId);
            if (!agent || agent.accountId !== accountId) {
                throw new Error("Agent does not belong to the supplied accountId");
            }
        }

        const defined = Object.fromEntries(
            Object.entries({ ...patch, agentId }).filter(([, v]) => v !== undefined),
        );

        await ctx.db.patch(cronJobId, { ...defined, updatedAt: Date.now() });
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
        cronJobId: v.id("cronJobs"),
        lastStatus: cronJobLastStatusValidator,
        lastError: v.optional(v.string()),
        lastInvokedAt: v.optional(v.number()),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, cronJobId, lastStatus, lastError, lastInvokedAt }) => {
        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (!cronJob) {
            throw new Error("Cron job does not belong to the supplied accountId");
        }

        await ctx.db.patch(cronJobId, {
            lastStatus,
            lastError,
            lastInvokedAt: lastInvokedAt ?? Date.now(),
            updatedAt: Date.now(),
        });
        return null;
    },
});

export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        cronJobId: v.id("cronJobs"),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, cronJobId }) => {
        const cronJob = await getOwned(ctx, accountId, cronJobId);
        if (cronJob) await ctx.db.delete(cronJobId);
        return null;
    },
});
