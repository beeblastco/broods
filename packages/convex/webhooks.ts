/**
 * Outbound webhook views for the dashboard. The harness delivers events from
 * each agent's `config.hooks.webhook`; this module aggregates those per-agent
 * hooks for an environment so the settings tab can show them. There is no
 * separate webhook store — the agent config is the source of truth.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";

/**
 * Aggregate the outbound webhooks configured per agent in an environment. These
 * live on each agent's `config.hooks.webhook` (the config the harness actually
 * delivers from) and are configured via the SDK/CLI or the agent Config tab, so
 * the settings tab can show them instead of leaving them buried in env vars.
 * @returns one row per agent that declares a webhook hook
 */
export const listAgentWebhooks = query({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: v.array(
        v.object({
            agentConfigId: v.id("agentConfigs"),
            agentName: v.string(),
            enabled: v.boolean(),
            url: v.optional(v.string()),
            secret: v.optional(v.string()),
            events: v.array(v.string()),
        }),
    ),
    handler: async (ctx, { projectId, environmentId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const environment = await getOwnedEnvironment(ctx, user.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            return [];
        }

        const configs = await ctx.db
            .query("agentConfigs")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .collect();

        const rows: Array<{
            agentConfigId: typeof configs[number]["_id"];
            agentName: string;
            enabled: boolean;
            url?: string;
            secret?: string;
            events: string[];
        }> = [];
        for (const config of configs) {
            const extra = config.extraConfig as { hooks?: { webhook?: Record<string, unknown> } } | undefined;
            const webhook = extra?.hooks?.webhook;
            if (!webhook) continue;
            rows.push({
                agentConfigId: config._id,
                agentName: config.name,
                enabled: webhook.enabled !== false,
                url: typeof webhook.url === "string" ? webhook.url : undefined,
                secret: typeof webhook.secret === "string" ? webhook.secret : undefined,
                events: Array.isArray(webhook.events) ? webhook.events.filter((event): event is string => typeof event === "string") : [],
            });
        }

        return rows;
    },
});
