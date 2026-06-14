/**
 * Helper queries used by the logs action.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { getOwnedProject } from "./model/ownership/project";

/**
 * Returns the caller's active environment-scoped runtime keys for a project, and
 * optionally a single environment, as `{ _id, endpointId }`. Scoping by
 * the config (which carries projectId/environmentId) keeps dashboard logs and
 * usage stats aligned with the environment selected in the UI.
 */
export const getActiveDeploymentsInternal = internalQuery({
    args: {
        authId: v.string(),
        projectId: v.id("projects"),
        environmentId: v.optional(v.id("environments")),
    },
    returns: v.array(v.object({
        _id: v.id("agentDeployments"),
        endpointId: v.string(),
    })),
    handler: async (ctx, args) => {
        const { authId, projectId, environmentId } = args;

        const project = await getOwnedProject(ctx, authId, projectId);
        if (!project) return [];

        // Env-scoped runtime key(s): one active key per (project, environment).
        const envDeployments = environmentId
            ? await ctx.db
                .query("agentDeployments")
                .withIndex("by_projectId_and_environmentId_and_status", (q) =>
                    q.eq("projectId", projectId).eq("environmentId", environmentId).eq("status", "active"),
                )
                .collect()
            : await ctx.db
                .query("agentDeployments")
                .withIndex("by_projectId_and_environmentId_and_status", (q) => q.eq("projectId", projectId))
                .collect();
        const scoped = envDeployments
            .filter((deployment) => deployment.status === "active")
            .map((deployment) => ({ _id: deployment._id, endpointId: deployment.endpointId }));

        return scoped;
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

        // Env-scoped runtime key for this (project, environment).
        const envDeployments = await ctx.db
            .query("agentDeployments")
            .withIndex("by_projectId_and_environmentId_and_status", (q) =>
                q.eq("projectId", project._id).eq("environmentId", environment._id).eq("status", "active"),
            )
            .collect();
        const sources = envDeployments.map((deployment) => ({
            logGroup: `/aws/lambda/${deployment.endpointId}`,
            functionName: deployment.endpointId,
        }));

        return sources;
    },
});
