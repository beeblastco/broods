"use node";
/**
 * Server-to-server invocation of filthy-panty's harness Lambda. Resolves the
 * caller's active accountId via Convex and forwards the prompt with the
 * shared service-token, returning the async eventId.
 */

import { v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * Fires an async run on filthy-panty for the caller's active org. Returns the
 * eventId so the dashboard can subscribe to asyncResults via live queries.
 */
export const invokeAsync = action({
    args: {
        agentId: v.id("agents"),
        prompt: v.string(),
        conversationKey: v.optional(v.string()),
    },
    returns: v.object({ eventId: v.string() }),
    handler: async (ctx, args) => {
        const { agentId, prompt, conversationKey } = args;

        const account = await ctx.runQuery(api.org.getActiveAccount, {});
        if (!account) {
            throw new Error("No active org / account not provisioned");
        }

        const harnessUrl = process.env.FILTHY_PANTY_HARNESS_URL;
        const serviceSecret = process.env.FILTHY_PANTY_SERVICE_AUTH_SECRET;
        if (!harnessUrl || !serviceSecret) {
            throw new Error(
                "FILTHY_PANTY_HARNESS_URL or FILTHY_PANTY_SERVICE_AUTH_SECRET missing",
            );
        }

        const response = await fetch(`${harnessUrl}/async`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${serviceSecret}`,
                "X-Account-Id": account.accountId,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                agentId: agentId,
                prompt: prompt,
                conversationKey: conversationKey,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Filthy-panty invoke failed: ${response.status} ${text}`);
        }

        const body = (await response.json()) as { eventId: string };
        return { eventId: body.eventId };
    },
});
