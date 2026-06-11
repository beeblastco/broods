/**
 * Async-job tracking for the harness-processing /async endpoint. Filthy-panty
 * Lambda writes status transitions; the dashboard reads them via live queries.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { asyncResultsFields } from "./schema";

const asyncResultDoc = v.object({
    ...asyncResultsFields,
    _id: v.id("asyncResults"),
    _creationTime: v.number(),
});

const statusValidator = v.union(
    v.literal("pending"),
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed"),
);

export const getByEventId = internalQuery({
    args: { eventId: v.string() },
    returns: v.union(asyncResultDoc, v.null()),
    handler: async (ctx, args) => {
        const result = await ctx.db
            .query("asyncResults")
            .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
            .unique();

        return result ?? null;
    },
});

export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(asyncResultDoc),
    handler: async (ctx, args) => {
        return await ctx.db
            .query("asyncResults")
            .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
            .collect();
    },
});

export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        eventId: v.string(),
        status: v.optional(statusValidator),
    },
    returns: v.id("asyncResults"),
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("asyncResults")
            .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
            .unique();
        if (existing) {
            throw new Error(`Async result already exists for eventId=${args.eventId}`);
        }

        const now = Date.now();
        return await ctx.db.insert("asyncResults", {
            accountId: args.accountId,
            eventId: args.eventId,
            status: args.status ?? "pending",
            result: undefined,
            error: undefined,
            createdAt: now,
            updatedAt: now,
        });
    },
});

export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        eventId: v.string(),
        status: v.optional(statusValidator),
        result: v.optional(v.any()),
        error: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const row = await ctx.db
            .query("asyncResults")
            .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
            .unique();
        if (!row) {
            throw new Error(`Async result not found for eventId=${args.eventId}`);
        }
        if (row.accountId !== args.accountId) {
            throw new Error("Async result does not belong to the supplied accountId");
        }

        await ctx.db.patch(row._id, {
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.result !== undefined ? { result: args.result } : {}),
            ...(args.error !== undefined ? { error: args.error } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});
