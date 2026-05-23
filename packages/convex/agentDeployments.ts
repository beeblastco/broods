/**
 * Temporary agent deployment stubs for canvas public-access UI.
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

/**
 * Lists deployments for an agent config owned by the authenticated user.
 * @param agentConfigId Agent config document id
 * @returns Deployment documents for the config
 */
export const list = query({
    args: {
        agentConfigId: v.id("agentConfigs"),
    },
    returns: v.array(agentDeploymentDoc),
    handler: async (ctx, args) => {
        const { agentConfigId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const config = await ctx.db.get(agentConfigId);
        if (!config || config.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        return await ctx.db
            .query("agentDeployments")
            .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", agentConfigId))
            .collect();
    },
});

/**
 * Creates a placeholder deployment record for canvas testing UI.
 * @param agentConfigId Agent config document id
 * @returns Deployment metadata including a one-time API key
 */
export const create = mutation({
    args: {
        agentConfigId: v.id("agentConfigs"),
    },
    returns: v.object({
        _id: v.id("agentDeployments"),
        endpointId: v.string(),
        rawApiKey: v.string(),
        projectSlug: v.string(),
        environmentSlug: v.string(),
    }),
    handler: async (ctx, args) => {
        const { agentConfigId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const config = await ctx.db.get(agentConfigId);
        if (!config || config.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        const project = await ctx.db.get(config.projectId);
        const environment = await ctx.db.get(config.environmentId);
        const endpointId = `agent-${agentConfigId.slice(-8)}`;
        const rawApiKey = `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
        const now = Date.now();

        const deploymentId = await ctx.db.insert("agentDeployments", {
            authId: authUser.id,
            agentConfigId: agentConfigId,
            status: "active",
            endpointId: endpointId,
            projectSlug: project?.slug ?? "project",
            environmentSlug: environment?.name.toLowerCase() ?? "production",
            apiKey: rawApiKey,
            updatedAt: now,
        });

        return {
            _id: deploymentId,
            endpointId: endpointId,
            rawApiKey: rawApiKey,
            projectSlug: project?.slug ?? "project",
            environmentSlug: environment?.name.toLowerCase() ?? "production",
        };
    },
});

/**
 * Revokes an active deployment owned by the authenticated user.
 * @param deploymentId Deployment document id
 * @returns Revoked deployment document id
 */
export const revoke = mutation({
    args: {
        deploymentId: v.id("agentDeployments"),
    },
    returns: v.id("agentDeployments"),
    handler: async (ctx, args) => {
        const { deploymentId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const deployment = await ctx.db.get(deploymentId);
        if (!deployment || deployment.authId !== authUser.id) {
            throw new Error("Deployment not found.");
        }

        await ctx.db.patch(deploymentId, {
            status: "revoked",
            updatedAt: Date.now(),
        });

        return deploymentId;
    },
});
