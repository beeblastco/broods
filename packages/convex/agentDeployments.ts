/**
 * Agent deployment stubs for canvas public-access UI.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { agentDeploymentsFields } from "./schema";

const agentDeploymentDoc = v.object({
    ...agentDeploymentsFields,
    _id: v.id("agentDeployments"),
    _creationTime: v.number(),
});

export const list = query({
    args: { agentConfigId: v.id("agentConfigs") },
    returns: v.array(agentDeploymentDoc),
    handler: async (ctx, { agentConfigId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        // Return empty rather than throwing so a just-deleted agent config doesn't
        // crash the reactive side panel before it unmounts.
        const config = await ctx.db.get(agentConfigId);
        if (!config || config.authId !== authUser.id) {
            return [];
        }

        return ctx.db
            .query("agentDeployments")
            .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", agentConfigId))
            .collect();
    },
});

export const create = mutation({
    args: { agentConfigId: v.id("agentConfigs") },
    returns: v.object({
        _id: v.id("agentDeployments"),
        endpointId: v.string(),
        rawApiKey: v.string(),
        projectSlug: v.string(),
        environmentSlug: v.string(),
    }),
    handler: async (ctx, { agentConfigId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const config = await ctx.db.get(agentConfigId);
        if (!config || config.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        const project = await ctx.db.get(config.projectId);
        const environment = await ctx.db.get(config.environmentId);
        const endpointId = `agent-${agentConfigId.slice(-8)}`;
        const rawApiKey = `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
        const projectSlug = project?.slug ?? "project";
        const environmentSlug = environment?.name.toLowerCase() ?? "production";

        const _id = await ctx.db.insert("agentDeployments", {
            authId: authUser.id,
            agentConfigId,
            status: "active",
            endpointId,
            projectSlug,
            environmentSlug,
            apiKey: rawApiKey,
            updatedAt: Date.now(),
        });

        return { _id, endpointId, rawApiKey, projectSlug, environmentSlug };
    },
});

export const revoke = mutation({
    args: { deploymentId: v.id("agentDeployments") },
    returns: v.id("agentDeployments"),
    handler: async (ctx, { deploymentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const deployment = await ctx.db.get(deploymentId);
        if (!deployment || deployment.authId !== authUser.id) {
            throw new Error("Deployment not found.");
        }

        await ctx.db.patch(deploymentId, { status: "revoked", updatedAt: Date.now() });
        return deploymentId;
    },
});
