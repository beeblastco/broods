/**
 * Project + environment scoped runtime API keys (`fp_agent_…`).
 *
 * One key per environment invokes any deployed agent in it; the agent is chosen
 * per request by id. The dashboard surfaces the key/URLs; the CLI mints it on
 * `deploy`. The SHA-256 hash authenticates runtime calls (`getByApiKeyHash` in
 * `core`); the plaintext is also stored AES-GCM encrypted so the owner can
 * recover it for dashboard streaming and CLI reconnect without rotating.
 */

import { v } from "convex/values";
import { scheduleServiceLog } from "./observability";
import type { Id } from "./_generated/dataModel";
import { internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import { decryptAgentConfigBlob, encryptAgentConfigBlob } from "./model/agentConfigCodec";
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

/** Secret for AES-GCM encrypting the runtime key at rest (shared with env vars). */
function encryptionSecret(): string {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store runtime API keys");
    }

    return secret;
}

/** Encrypt a plaintext key into the three at-rest blob fields stored on the row. */
async function encryptApiKey(rawApiKey: string) {
    const blob = await encryptAgentConfigBlob({ value: rawApiKey }, encryptionSecret());

    return { apiKeyCiphertext: blob.ciphertext, apiKeyIv: blob.iv, apiKeyTag: blob.tag };
}

/** Decrypt a deployment's stored runtime key. */
async function decryptApiKey(deployment: {
    apiKeyCiphertext: string;
    apiKeyIv: string;
    apiKeyTag: string;
}): Promise<string> {
    const decoded = await decryptAgentConfigBlob(
        { ciphertext: deployment.apiKeyCiphertext, iv: deployment.apiKeyIv, tag: deployment.apiKeyTag },
        encryptionSecret(),
    );
    const value = (decoded as { value?: unknown } | null)?.value;

    if (typeof value !== "string") throw new Error("Stored runtime API key is invalid");

    return value;
}

/** Public (hash-free) view of an environment deployment for the dashboard. */
const environmentDeploymentView = v.object({
    _id: v.id("agentDeployments"),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    keyHint: v.string(),
    updatedAt: v.number(),
});

type EnsureResult = {
    deploymentId: Id<"agentDeployments">;
    endpointId: string;
    projectSlug: string;
    environmentSlug: string;
    keyHint: string;
    /** Plaintext key: freshly minted, or recovered from the stored blob. */
    rawApiKey: string;
};

/**
 * Find the environment's active deployment, creating one (with a fresh key) when
 * absent. When `rotate` is true an existing key is regenerated. Returns the raw
 * key whenever it can — minted now, or decrypted from the at-rest blob.
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
        // Keep slugs fresh (project/environment can be renamed) but reuse the key,
        // recovering its plaintext from the stored blob.
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
            keyHint: existing.keyHint,
            rawApiKey: await decryptApiKey(existing),
        };
    }

    const rawApiKey = generateDeploymentKey();
    const apiKeyHash = await sha256Hex(rawApiKey);
    const keyHint = deploymentKeyHint(rawApiKey);
    const encryptedKey = await encryptApiKey(rawApiKey);
    const now = Date.now();

    if (existing) {
        await ctx.db.patch(existing._id, {
            apiKeyHash: apiKeyHash,
            keyHint: keyHint,
            ...encryptedKey,
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
        ...encryptedKey,
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

/**
 * Owner-only: decrypts the environment's stored runtime key so the dashboard can
 * stream logs/traces without re-minting. Returns null when the environment has no
 * deployment yet. Reactive by design, so a freshly generated key appears without
 * a reload.
 */
export const revealKeyForEnvironment = query({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: v.union(v.string(), v.null()),
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return null;

        const deployment = await ctx.db
            .query("agentDeployments")
            .withIndex("by_projectId_and_environmentId_and_status", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId).eq("status", "active"),
            )
            .first();
        if (!deployment) return null;

        return decryptApiKey(deployment);
    },
});

const ensureReturn = v.object({
    _id: v.id("agentDeployments"),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    keyHint: v.string(),
    rawApiKey: v.string(),
});

/** Ensure the environment has a recoverable runtime key, creating one on first call. */
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
        await scheduleServiceLog(ctx, {
            projectId: projectId,
            environmentId: environmentId,
            eventType: "service.deployment.ready",
            message: "Environment runtime deployment is ready",
            data: { endpointId: result.endpointId },
        });

        return toEnsureReturn(result);
    },
});

/**
 * Regenerate the environment's runtime key and return the new plaintext. If the
 * environment has no key yet this mints the first one (same as
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
        await scheduleServiceLog(ctx, {
            projectId: projectId,
            environmentId: environmentId,
            eventType: "service.deployment.key.rotated",
            message: "Environment runtime key rotated",
            data: { endpointId: result.endpointId },
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

/** Resolve the active environment deployment linked to one runtime agent. */
export const getByAgentId = internalQuery({
    args: {
        accountId: v.id("accounts"),
        agentId: v.string(),
    },
    returns: v.union(
        v.object({
            accountId: v.id("accounts"),
            endpointId: v.string(),
            projectSlug: v.string(),
            environmentSlug: v.string(),
        }),
        v.null(),
    ),
    handler: async (ctx, args) => {
        const runtimeAgentId = ctx.db.normalizeId("agents", args.agentId);
        if (!runtimeAgentId) return null;
        const runtimeAgent = await ctx.db.get(runtimeAgentId);
        if (!runtimeAgent || runtimeAgent.accountId !== args.accountId) return null;

        const config = await ctx.db
            .query("agentConfigs")
            .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
            .unique();
        if (!config) return null;

        const deployment = await ctx.db
            .query("agentDeployments")
            .withIndex("by_projectId_and_environmentId_and_status", (q) =>
                q
                    .eq("projectId", config.projectId)
                    .eq("environmentId", config.environmentId)
                    .eq("status", "active"),
            )
            .unique();
        if (!deployment || deployment.accountId !== args.accountId) return null;

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
