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
