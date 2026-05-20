/** Helper queries used by the logs action. */

import { v } from "convex/values";
import { query } from "./_generated/server";

export const getActiveDeploymentsInternal = query({
    args: {
        authId: v.string(),
        projectId: v.id("projects"),
    },
    returns: v.array(v.object({
        _id: v.id("agentDeployments"),
        endpointId: v.string(),
    })),
    handler: async (ctx, args) => {
        const { authId } = args;

        const deployments = await ctx.db
            .query("agentDeployments")
            .withIndex("by_authId", (q) => q.eq("authId", authId))
            .collect();

        const active = deployments.filter((d) => d.status === "active");

        return active.map((d) => ({
            _id: d._id,
            endpointId: d.endpointId,
        }));
    },
});
