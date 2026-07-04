"use node";
/**
 * Public action wrappers for cron CRUD. These proxy to broods's
 * /v1/crons HTTP endpoints so EventBridge Scheduler stays in
 * sync with Convex. Cherry-coke never touches AWS directly.
 */

import { v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";

const STATUS_VALIDATOR = v.union(v.literal("active"), v.literal("paused"));

function getServiceEnv(): { url: string; secret: string } {
    const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
    const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
    if (!url || !secret) {
        throw new Error(
            "BROODS_ACCOUNT_MANAGE_URL or BROODS_SERVICE_AUTH_SECRET missing",
        );
    }
    return { url: url.replace(/\/+$/, ""), secret: secret };
}

function headers(accountId: string, secret: string): HeadersInit {
    return {
        Authorization: `Bearer ${secret}`,
        "X-Account-Id": accountId,
        "Content-Type": "application/json",
    };
}

/** Creates a cron job via broods (HTTP -> EBS + Convex dual-write). */
export const create = action({
    args: {
        name: v.string(),
        agentId: v.id("agents"),
        input: v.string(),
        conversationKey: v.optional(v.string()),
        scheduleExpression: v.string(),
        timezone: v.optional(v.string()),
        status: STATUS_VALIDATOR,
        description: v.optional(v.string()),
    },
    returns: v.object({ cronId: v.string() }),
    handler: async (ctx, args) => {
        const account = await ctx.runQuery(api.org.getActiveAccount, {});
        if (!account) throw new Error("No active org / account not provisioned");

        const { url, secret } = getServiceEnv();
        const res = await fetch(`${url}/v1/crons`, {
            method: "POST",
            headers: headers(account.accountId, secret),
            body: JSON.stringify(args),
        });
        if (!res.ok) {
            throw new Error(
                `Broods create cron failed: ${res.status} ${await res.text()}`,
            );
        }
        const { cron } = (await res.json()) as { cron: { cronId: string } };
        return { cronId: cron.cronId };
    },
});

/** Updates a cron job via broods. */
export const update = action({
    args: {
        cronId: v.string(),
        name: v.optional(v.string()),
        agentId: v.optional(v.id("agents")),
        input: v.optional(v.string()),
        conversationKey: v.optional(v.string()),
        scheduleExpression: v.optional(v.string()),
        timezone: v.optional(v.string()),
        status: v.optional(STATUS_VALIDATOR),
        description: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { cronId, ...patch } = args;
        const account = await ctx.runQuery(api.org.getActiveAccount, {});
        if (!account) throw new Error("No active org / account not provisioned");

        const { url, secret } = getServiceEnv();
        const res = await fetch(`${url}/v1/crons/${cronId}`, {
            method: "PATCH",
            headers: headers(account.accountId, secret),
            body: JSON.stringify(patch),
        });
        if (!res.ok) {
            throw new Error(
                `Broods update cron failed: ${res.status} ${await res.text()}`,
            );
        }
        return null;
    },
});

/** Removes a cron job via broods. */
export const remove = action({
    args: { cronId: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const account = await ctx.runQuery(api.org.getActiveAccount, {});
        if (!account) throw new Error("No active org / account not provisioned");

        const { url, secret } = getServiceEnv();
        const res = await fetch(`${url}/v1/crons/${args.cronId}`, {
            method: "DELETE",
            headers: headers(account.accountId, secret),
        });
        if (!res.ok) {
            throw new Error(
                `Broods delete cron failed: ${res.status} ${await res.text()}`,
            );
        }
        return null;
    },
});
