/**
 * Per-environment outbound webhooks. Each endpoint is scoped to one project
 * environment and receives the events it subscribes to. The signing secret is
 * generated server-side and stored in plaintext so it can be revealed for
 * receiver-side signature verification.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { webhooksFields } from "./schema";

const webhookDoc = v.object({
    ...webhooksFields,
    _id: v.id("webhooks"),
    _creationTime: v.number(),
});

/**
 * Generate a random `whsec_<hex>` signing secret for a webhook endpoint.
 * @returns a 64-char hex secret prefixed with `whsec_`
 */
function generateWebhookSecret(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));

    return `whsec_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const list = query({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: v.array(webhookDoc),
    handler: async (ctx, { projectId, environmentId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        // Return empty rather than throwing so a just-deleted environment doesn't
        // crash reactive subscribers before they unmount.
        const environment = await getOwnedEnvironment(ctx, user.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            return [];
        }

        return ctx.db
            .query("webhooks")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .collect();
    },
});

export const create = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        url: v.string(),
        events: v.array(v.string()),
    },
    returns: v.id("webhooks"),
    handler: async (ctx, { projectId, environmentId, url, events }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const environment = await getOwnedEnvironment(ctx, user.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const trimmedUrl = url.trim();
        if (!trimmedUrl) throw new Error("Webhook URL is required.");

        const now = Date.now();

        return ctx.db.insert("webhooks", {
            projectId: projectId,
            environmentId: environmentId,
            url: trimmedUrl,
            secret: generateWebhookSecret(),
            events: events,
            active: true,
            createdAt: now,
            updatedAt: now,
        });
    },
});

/** Patch a webhook's URL, subscribed events, and/or active flag. */
export const update = mutation({
    args: {
        webhookId: v.id("webhooks"),
        url: v.optional(v.string()),
        events: v.optional(v.array(v.string())),
        active: v.optional(v.boolean()),
    },
    returns: v.id("webhooks"),
    handler: async (ctx, { webhookId, url, events, active }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const webhook = await ctx.db.get(webhookId);
        if (!webhook) throw new Error("Webhook not found.");

        const environment = await getOwnedEnvironment(ctx, user.id, webhook.environmentId);
        if (!environment) throw new Error("Webhook not found.");

        const patch: { url?: string; events?: string[]; active?: boolean; updatedAt: number } = {
            updatedAt: Date.now(),
        };
        if (url !== undefined) {
            const trimmedUrl = url.trim();
            if (!trimmedUrl) throw new Error("Webhook URL is required.");
            patch.url = trimmedUrl;
        }
        if (events !== undefined) patch.events = events;
        if (active !== undefined) patch.active = active;

        await ctx.db.patch(webhookId, patch);

        return webhookId;
    },
});

/** Rotate a webhook's signing secret, invalidating the previous one. */
export const rotateSecret = mutation({
    args: { webhookId: v.id("webhooks") },
    returns: v.id("webhooks"),
    handler: async (ctx, { webhookId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const webhook = await ctx.db.get(webhookId);
        if (!webhook) throw new Error("Webhook not found.");

        const environment = await getOwnedEnvironment(ctx, user.id, webhook.environmentId);
        if (!environment) throw new Error("Webhook not found.");

        await ctx.db.patch(webhookId, { secret: generateWebhookSecret(), updatedAt: Date.now() });

        return webhookId;
    },
});

export const remove = mutation({
    args: { webhookId: v.id("webhooks") },
    returns: v.id("webhooks"),
    handler: async (ctx, { webhookId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const webhook = await ctx.db.get(webhookId);
        if (!webhook) throw new Error("Webhook not found.");

        const environment = await getOwnedEnvironment(ctx, user.id, webhook.environmentId);
        if (!environment) throw new Error("Webhook not found.");

        await ctx.db.delete(webhookId);

        return webhookId;
    },
});
