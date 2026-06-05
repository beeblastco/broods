/**
 * Helper queries used by the logs action.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const getActiveDeploymentsInternal = internalQuery({
    args: {
        authId: v.string(),
        projectId: v.id("projects"),
    },
    returns: v.array(v.object({
        _id: v.id("agentDeployments"),
        endpointId: v.string(),
    })),
    handler: async (ctx, args) => {
        const deployments = await ctx.db
            .query("agentDeployments")
            .withIndex("by_authId", (q) => q.eq("authId", args.authId))
            .collect();

        return deployments
            .filter((d) => d.status === "active")
            .map((d) => ({ _id: d._id, endpointId: d.endpointId }));
    },
});

export const getCliLogSourcesBySecretHash = internalQuery({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
    },
    returns: v.union(
        v.null(),
        v.array(v.object({
            logGroup: v.string(),
            functionName: v.string(),
        })),
    ),
    handler: async (ctx, args) => {
        const account = await ctx.db
            .query("accounts")
            .withIndex("by_secretHash", (q) => q.eq("secretHash", args.secretHash))
            .unique();
        if (!account || account.status !== "active") return null;

        const orgId = ctx.db.normalizeId("orgs", account.orgId);
        if (!orgId) return null;
        const org = await ctx.db.get(orgId);
        if (!org) return null;

        const projects = await ctx.db
            .query("projects")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .collect();
        const project = projects.find((entry) => entry.name === args.project || entry.slug === args.project);
        if (!project) return null;

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
            .collect();
        const environment = environments.find((entry) => entry.name === args.environment);
        if (!environment) return null;

        const agentConfigs = await ctx.db
            .query("agentConfigs")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", project._id).eq("environmentId", environment._id),
            )
            .collect();

        const sources = [];
        for (const config of agentConfigs) {
            const deployments = await ctx.db
                .query("agentDeployments")
                .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
                .collect();
            for (const deployment of deployments) {
                if (deployment.status !== "active") continue;
                sources.push({
                    logGroup: `/aws/lambda/${deployment.endpointId}`,
                    functionName: deployment.endpointId,
                });
            }
        }

        return sources;
    },
});
