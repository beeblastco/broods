/**
 * Async-job tracking for the harness-processing /async endpoint. Filthy-panty
 * Lambda writes status transitions; cherry-coke reads them via live queries
 * for the dashboard's "Tasks" view.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { asyncResultsFields } from "./schema";

const asyncResultDoc = v.object({
    ...asyncResultsFields,
    _id: v.id("asyncResults"),
    _creationTime: v.number(),
});

/** Returns the async result for an eventId, or null when unknown. */
export const getByEventId = internalQuery({
    args: { eventId: v.string() },
    returns: v.union(asyncResultDoc, v.null()),
    handler: async (ctx, args) => {
        const { eventId } = args;
        const result = await ctx.db
            .query("asyncResults")
            .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
            .unique();

        return result ?? null;
    },
});

/** Lists every async result for the supplied account. */
export const list = internalQuery({
    args: { accountId: v.id("accounts") },
    returns: v.array(asyncResultDoc),
    handler: async (ctx, args) => {
        const { accountId } = args;
        const results = await ctx.db
            .query("asyncResults")
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();

        return results;
    },
});

/** Inserts a new async-result row, defaulting status to "pending". */
export const create = internalMutation({
    args: {
        accountId: v.id("accounts"),
        eventId: v.string(),
        status: v.optional(
            v.union(
                v.literal("pending"),
                v.literal("running"),
                v.literal("completed"),
                v.literal("failed"),
            ),
        ),
    },
    returns: v.id("asyncResults"),
    handler: async (ctx, args) => {
        const { accountId, eventId, status } = args;

        const existing = await ctx.db
            .query("asyncResults")
            .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
            .unique();
        if (existing) {
            throw new Error(`Async result already exists for eventId=${eventId}`);
        }

        const now = Date.now();
        const id = await ctx.db.insert("asyncResults", {
            accountId: accountId,
            eventId: eventId,
            status: status ?? "pending",
            result: undefined,
            error: undefined,
            createdAt: now,
            updatedAt: now,
        });

        return id;
    },
});

/** Updates status / result / error after verifying account ownership. */
export const update = internalMutation({
    args: {
        accountId: v.id("accounts"),
        eventId: v.string(),
        status: v.optional(
            v.union(
                v.literal("pending"),
                v.literal("running"),
                v.literal("completed"),
                v.literal("failed"),
            ),
        ),
        result: v.optional(v.any()),
        error: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { accountId, eventId, status, result, error } = args;

        const row = await ctx.db
            .query("asyncResults")
            .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
            .unique();
        if (!row) {
            throw new Error(`Async result not found for eventId=${eventId}`);
        }
        if (row.accountId !== accountId) {
            throw new Error(
                "Async result does not belong to the supplied accountId",
            );
        }

        await ctx.db.patch(row._id, {
            ...(status !== undefined ? { status: status } : {}),
            ...(result !== undefined ? { result: result } : {}),
            ...(error !== undefined ? { error: error } : {}),
            updatedAt: Date.now(),
        });

        return null;
    },
});
