/**
 * Project + environment scoped runtime API keys (`fp_agent_…`).
 *
 * One key per environment invokes any deployed agent in it; the agent is chosen
 * per request by id. The dashboard surfaces the key/URLs; the CLI mints it on
 * `deploy`. Only the SHA-256 hash is stored — the plaintext is returned once at
 * creation or rotation. The runtime path resolves it in `core` via
 * `getByApiKeyHash`.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getProjectForRole } from "./model/ownership/project";

const DEPLOYMENT_KEY_PREFIX = "fp_agent_";

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

/** Safe display label for a deployment key: prefix + last four chars. */
function deploymentKeyHint(token: string): string {
    return `${DEPLOYMENT_KEY_PREFIX}…${token.slice(-4)}`;
}

/** Stable opaque endpoint handle for an environment's runtime API. */
function endpointIdForEnvironment(environmentId: Id<"environments">): string {
    return `env-${environmentId.slice(-8)}`;
}

/** Public (hash-free) view of an environment deployment for the dashboard. */
const environmentDeploymentView = v.object({
    _id: v.id("agentDeployments"),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    keyHint: v.optional(v.string()),
    updatedAt: v.number(),
});

type EnsureResult = {
    deploymentId: Id<"agentDeployments">;
    endpointId: string;
    projectSlug: string;
    environmentSlug: string;
    keyHint: string;
    /** Plaintext key — present only when a key was just created or rotated. */
    rawApiKey: string | null;
};

/**
 * Find the environment's active deployment, creating one (with a fresh key) when
 * absent. When `rotate` is true an existing key is regenerated. Returns the raw
 * key only when it was just minted, mirroring the reveal-once contract.
 */
export async function ensureEnvironmentDeployment(
    ctx: MutationCtx,
    args: {
        authId: string;
        accountId: Id<"accounts">;
        projectId: Id<"projects">;
        environmentId: Id<"environments">;
        projectSlug: string;
        environmentSlug: string;
        rotate?: boolean;
    },
): Promise<EnsureResult> {
    const endpointId = endpointIdForEnvironment(args.environmentId);
    const existing = await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_environmentId_and_status", (q) =>
            q.eq("projectId", args.projectId).eq("environmentId", args.environmentId).eq("status", "active"),
        )
        .first();

    if (existing && args.rotate !== true) {
        // Keep slugs fresh (project/environment can be renamed) but reuse the key.
        if (existing.projectSlug !== args.projectSlug || existing.environmentSlug !== args.environmentSlug) {
            await ctx.db.patch(existing._id, {
                projectSlug: args.projectSlug,
                environmentSlug: args.environmentSlug,
                updatedAt: Date.now(),
            });
        }

        return {
            deploymentId: existing._id,
            endpointId: existing.endpointId,
            projectSlug: args.projectSlug,
            environmentSlug: args.environmentSlug,
            keyHint: existing.keyHint ?? "",
            rawApiKey: null,
        };
    }

    const rawApiKey = generateDeploymentKey();
    const apiKeyHash = await sha256Hex(rawApiKey);
    const keyHint = deploymentKeyHint(rawApiKey);
    const now = Date.now();

    if (existing) {
        await ctx.db.patch(existing._id, {
            apiKeyHash: apiKeyHash,
            keyHint: keyHint,
            projectSlug: args.projectSlug,
            environmentSlug: args.environmentSlug,
            updatedAt: now,
        });

        return {
            deploymentId: existing._id,
            endpointId: existing.endpointId,
            projectSlug: args.projectSlug,
            environmentSlug: args.environmentSlug,
            keyHint: keyHint,
            rawApiKey: rawApiKey,
        };
    }

    const deploymentId = await ctx.db.insert("agentDeployments", {
        authId: args.authId,
        accountId: args.accountId,
        projectId: args.projectId,
        environmentId: args.environmentId,
        status: "active",
        endpointId: endpointId,
        projectSlug: args.projectSlug,
        environmentSlug: args.environmentSlug,
        apiKeyHash: apiKeyHash,
        keyHint: keyHint,
        updatedAt: now,
    });

    return {
        deploymentId: deploymentId,
        endpointId: endpointId,
        projectSlug: args.projectSlug,
        environmentSlug: args.environmentSlug,
        keyHint: keyHint,
        rawApiKey: rawApiKey,
    };
}

/** Resolve the project's org account, slug, and the environment's slug. */
async function resolveEnvironmentContext(
    ctx: MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
) {
    const project = await ctx.db.get(projectId);
    if (!project?.orgId) throw new Error("Project is not linked to an organization.");
    const environment = await ctx.db.get(environmentId);
    if (!environment || environment.projectId !== projectId) throw new Error("Environment not found.");

    const account = await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
        .unique();
    if (!account) {
        throw new Error("Provision your organization's API account first (Settings → API Access).");
    }

    return {
        account: account,
        projectSlug: project.slug ?? "project",
        environmentSlug: environment.name.toLowerCase(),
        authId: project.authId,
    };
}

/** The environment's active deployment for display (no secret material). */
export const getForEnvironment = query({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: v.union(environmentDeploymentView, v.null()),
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        // Return null rather than throwing so a just-deleted environment doesn't
        // crash the reactive side panel before it unmounts.
        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return null;

        const deployment = await ctx.db
            .query("agentDeployments")
            .withIndex("by_projectId_and_environmentId_and_status", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId).eq("status", "active"),
            )
            .first();
        if (!deployment) return null;

        return {
            _id: deployment._id,
            endpointId: deployment.endpointId,
            projectSlug: deployment.projectSlug,
            environmentSlug: deployment.environmentSlug,
            keyHint: deployment.keyHint,
            updatedAt: deployment.updatedAt,
        };
    },
});

const ensureReturn = v.object({
    _id: v.id("agentDeployments"),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    keyHint: v.string(),
    rawApiKey: v.union(v.string(), v.null()),
});

/** Ensure the environment has a runtime key, creating one on first call. */
export const ensureForEnvironment = mutation({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: ensureReturn,
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getProjectForRole(ctx, authUser.id, projectId, "admin");
        if (!project) throw new Error("Project not found.");
        const context = await resolveEnvironmentContext(ctx, projectId, environmentId);
        const result = await ensureEnvironmentDeployment(ctx, {
            authId: context.authId,
            accountId: context.account._id,
            projectId: projectId,
            environmentId: environmentId,
            projectSlug: context.projectSlug,
            environmentSlug: context.environmentSlug,
        });

        return toEnsureReturn(result);
    },
});

/**
 * Regenerate the environment's runtime key, returning the new plaintext once. If
 * the environment has no key yet this mints the first one (same as
 * `ensureForEnvironment`), so a rotate is always safe to call.
 */
export const rotate = mutation({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: ensureReturn,
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getProjectForRole(ctx, authUser.id, projectId, "admin");
        if (!project) throw new Error("Project not found.");
        const context = await resolveEnvironmentContext(ctx, projectId, environmentId);
        const result = await ensureEnvironmentDeployment(ctx, {
            authId: context.authId,
            accountId: context.account._id,
            projectId: projectId,
            environmentId: environmentId,
            projectSlug: context.projectSlug,
            environmentSlug: context.environmentSlug,
            rotate: true,
        });

        return toEnsureReturn(result);
    },
});

/** Resolve a runtime API key hash to the account and scope it invokes. */
export const getByApiKeyHash = internalQuery({
    args: { apiKeyHash: v.string() },
    returns: v.union(
        v.object({
            accountId: v.id("accounts"),
            endpointId: v.string(),
            projectSlug: v.string(),
            environmentSlug: v.string(),
        }),
        v.null(),
    ),
    handler: async (ctx, { apiKeyHash }) => {
        const deployment = await ctx.db
            .query("agentDeployments")
            .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", apiKeyHash))
            .unique();
        if (!deployment || deployment.status !== "active") return null;

        const account = await ctx.db.get(deployment.accountId);
        if (!account || account.status !== "active") return null;

        return {
            accountId: deployment.accountId,
            endpointId: deployment.endpointId,
            projectSlug: deployment.projectSlug,
            environmentSlug: deployment.environmentSlug,
        };
    },
});

function toEnsureReturn(result: EnsureResult) {
    return {
        _id: result.deploymentId,
        endpointId: result.endpointId,
        projectSlug: result.projectSlug,
        environmentSlug: result.environmentSlug,
        keyHint: result.keyHint,
        rawApiKey: result.rawApiKey,
    };
}
