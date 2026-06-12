/**
 * Agent deployment stubs for canvas public-access UI.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedProject, getProjectForRole } from "./model/ownership/project";
import { agentDeploymentsFields } from "./schema";

const DEPLOYMENT_KEY_PREFIX = "fp_agent_";

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
        if (!config || !(await getOwnedProject(ctx, authUser.id, config.projectId))) {
            return [];
        }

        return ctx.db
            .query("agentDeployments")
            .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", agentConfigId))
            .collect();
    },
});

/** SHA-256 hex digest for one-time deployment API keys. */
async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generate a random raw deployment key. */
function generateDeploymentKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    return `${DEPLOYMENT_KEY_PREFIX}${base64url}`;
}

/** Safe display label for a deployment key. */
function deploymentKeyHint(token: string): string {
    return `${DEPLOYMENT_KEY_PREFIX}...${token.slice(-4)}`;
}

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
        if (!config || !(await getProjectForRole(ctx, authUser.id, config.projectId, "admin"))) {
            throw new Error("Agent config not found.");
        }

        const project = await ctx.db.get(config.projectId);
        const environment = await ctx.db.get(config.environmentId);
        const endpointId = `agent-${agentConfigId.slice(-8)}`;
        const rawApiKey = generateDeploymentKey();
        const apiKeyHash = await sha256Hex(rawApiKey);
        const projectSlug = project?.slug ?? "project";
        const environmentSlug = environment?.name.toLowerCase() ?? "production";

        const _id = await ctx.db.insert("agentDeployments", {
            authId: authUser.id,
            agentConfigId,
            status: "active",
            endpointId,
            projectSlug,
            environmentSlug,
            apiKeyHash: apiKeyHash,
            keyHint: deploymentKeyHint(rawApiKey),
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
        if (!deployment) {
            throw new Error("Deployment not found.");
        }
        const config = await ctx.db.get(deployment.agentConfigId);
        if (!config || !(await getProjectForRole(ctx, authUser.id, config.projectId, "admin"))) {
            throw new Error("Deployment not found.");
        }

        await ctx.db.patch(deploymentId, { status: "revoked", updatedAt: Date.now() });
        return deploymentId;
    },
});
