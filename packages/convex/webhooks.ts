/**
 * Outbound webhook views and editing for the dashboard. The harness delivers
 * events from each agent's `config.hooks.webhooks` array; this module surfaces
 * those per-agent hooks for an environment and lets the settings tab add, toggle,
 * and remove them. There is no separate webhook store — the agent config is the
 * source of truth.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import { ensureAgentsRowForConfig, pushEncryptedConfigToAgentRow } from "./model/agentSync";
import { isPlainObject } from "./model/objects";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { scheduleServiceLog } from "./observability";

/** One outbound webhook configured on an agent (URL/secret usually resolve from env vars). */
const webhookRow = v.object({
    index: v.number(),
    enabled: v.boolean(),
    url: v.optional(v.string()),
    secret: v.optional(v.string()),
    events: v.array(v.string()),
});

/** Reads the `hooks.webhooks` array out of an agent config's `extraConfig` blob. */
function readWebhooks(extraConfig: unknown): Record<string, unknown>[] {
    const hooks = isPlainObject(extraConfig) && isPlainObject(extraConfig.hooks) ? extraConfig.hooks : undefined;
    const webhooks = hooks && Array.isArray(hooks.webhooks) ? hooks.webhooks : [];

    return webhooks.filter(isPlainObject);
}

/**
 * List every agent in an environment with its configured outbound webhooks. Agents
 * with no webhooks are still returned so the settings tab can offer an empty agent
 * to add one to.
 * @returns one entry per agent, each carrying its indexed webhook rows
 */
export const listAgentWebhooks = query({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: v.array(
        v.object({
            agentConfigId: v.id("agentConfigs"),
            agentName: v.string(),
            webhooks: v.array(webhookRow),
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

        return configs.map((config) => ({
            agentConfigId: config._id,
            agentName: config.name,
            webhooks: readWebhooks(config.extraConfig).map((webhook, index) => ({
                index,
                enabled: webhook.enabled !== false,
                url: typeof webhook.url === "string" ? webhook.url : undefined,
                secret: typeof webhook.secret === "string" ? webhook.secret : undefined,
                events: Array.isArray(webhook.events)
                    ? webhook.events.filter((event): event is string => typeof event === "string")
                    : [],
            })),
        }));
    },
});

/**
 * Load an owned agent config, apply a transform to its `hooks.webhooks` array, and
 * persist the result back into `extraConfig` plus the encrypted runtime agents row.
 * @param mutate receives the current webhooks and returns the next array
 * @throws when the config is missing or the caller does not own its project
 */
async function mutateAgentWebhooks(
    ctx: MutationCtx,
    authId: string,
    agentConfigId: Id<"agentConfigs">,
    mutate: (webhooks: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
    const config = await ctx.db.get(agentConfigId);
    if (!config || !(await getOwnedProject(ctx, authId, config.projectId))) {
        throw new Error("Agent config not found.");
    }

    const extra: Record<string, unknown> = isPlainObject(config.extraConfig) ? { ...config.extraConfig } : {};
    const hooks: Record<string, unknown> = isPlainObject(extra.hooks) ? { ...extra.hooks } : {};
    hooks.webhooks = mutate(readWebhooks(config.extraConfig));
    extra.hooks = hooks;

    await ctx.db.patch(agentConfigId, { extraConfig: extra, updatedAt: Date.now() });
    await ensureAgentsRowForConfig(ctx, agentConfigId, authId);
    await pushEncryptedConfigToAgentRow(ctx, agentConfigId);
}

async function requireUser(ctx: MutationCtx): Promise<{ id: string }> {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
        throw new Error("User not found or not authenticated");
    }

    return user;
}

async function scheduleWebhookLog(
    ctx: MutationCtx,
    agentConfigId: Id<"agentConfigs">,
    eventType: string,
    message: string,
    data?: Record<string, unknown>,
): Promise<void> {
    const config = await ctx.db.get(agentConfigId);
    if (!config) return;
    await scheduleServiceLog(ctx, {
        projectId: config.projectId,
        environmentId: config.environmentId,
        eventType: eventType,
        message: message,
        agentId: config.agentId,
        data: { agentConfigId: agentConfigId, ...data },
    });
}

/**
 * Append a new outbound webhook to an agent.
 * @returns null
 */
export const addAgentWebhook = mutation({
    args: {
        agentConfigId: v.id("agentConfigs"),
        url: v.string(),
        secret: v.string(),
        events: v.optional(v.array(v.string())),
        enabled: v.optional(v.boolean()),
    },
    returns: v.null(),
    handler: async (ctx, { agentConfigId, url, secret, events, enabled }) => {
        const user = await requireUser(ctx);
        await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) => [
            ...webhooks,
            {
                enabled: enabled !== false,
                url: url.trim(),
                secret: secret.trim(),
                events: events ?? [],
            },
        ]);
        await scheduleWebhookLog(ctx, agentConfigId, "service.webhook.created", "Agent webhook created", {
            events: events ?? [],
            enabled: enabled !== false,
        });

        return null;
    },
});

/**
 * Enable or disable a single webhook on an agent by its index.
 * @returns null
 */
export const setAgentWebhookEnabled = mutation({
    args: {
        agentConfigId: v.id("agentConfigs"),
        index: v.number(),
        enabled: v.boolean(),
    },
    returns: v.null(),
    handler: async (ctx, { agentConfigId, index, enabled }) => {
        const user = await requireUser(ctx);
        await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) =>
            webhooks.map((webhook, i) => (i === index ? { ...webhook, enabled: enabled } : webhook)),
        );
        await scheduleWebhookLog(ctx, agentConfigId, "service.webhook.updated", "Agent webhook updated", {
            index: index,
            enabled: enabled,
        });

        return null;
    },
});

/**
 * Remove a webhook from an agent by its index.
 * @returns null
 */
export const removeAgentWebhook = mutation({
    args: {
        agentConfigId: v.id("agentConfigs"),
        index: v.number(),
    },
    returns: v.null(),
    handler: async (ctx, { agentConfigId, index }) => {
        const user = await requireUser(ctx);
        await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) =>
            webhooks.filter((_, i) => i !== index),
        );
        await scheduleWebhookLog(ctx, agentConfigId, "service.webhook.deleted", "Agent webhook deleted", {
            index: index,
        });

        return null;
    },
});
