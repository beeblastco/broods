/**
 * CLI manifest sync for code-defined BeeBlast resources.
 *
 * Authenticates with the org Bearer secret and writes desired-state resources
 * into the SaaS project/environment model before syncing runtime agent rows.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { CliManifestResource, GeneratedIds } from "./cliTypes";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ensureEnvironmentDeployment } from "./agentDeployments";
import {
    ensureAgentsRowForConfig,
    pushEncryptedConfigToAgentRow,
    refreshAgentConfigsForEnvironmentVariable,
    syncAgentRowFields,
} from "./model/agentSync";
import { refreshSandboxConfigsForEnvironmentVariable } from "./model/sandboxConfigSync";
import {
    decryptAgentConfigBlob,
    encryptAgentConfigBlob,
    fromNestedAgentConfig,
    substituteEnvPlaceholders,
    toNestedAgentConfig,
} from "./model/agentConfigCodec";
import { saveAgentRuntimeSecrets } from "./model/agentRuntimeSecrets";
import { loadEnvironmentVariableValues } from "./model/environmentValues";
import { uniqueProjectSlug } from "./lib/slug";

const resourceValidator = v.object({
    kind: v.union(
        v.literal("agent"),
        v.literal("workspace"),
        v.literal("sandbox"),
        v.literal("cron"),
        v.literal("skill"),
        v.literal("tool"),
    ),
    name: v.string(),
    description: v.optional(v.string()),
    config: v.any(),
});

const manifestValidator = v.object({
    version: v.literal(1),
    project: v.string(),
    environment: v.string(),
    resources: v.array(resourceValidator),
});

const idsValidator = v.object({
    agents: v.record(v.string(), v.string()),
    workspaces: v.record(v.string(), v.string()),
    sandboxes: v.record(v.string(), v.string()),
    crons: v.record(v.string(), v.string()),
    skills: v.record(v.string(), v.string()),
    tools: v.record(v.string(), v.string()),
});

/**
 * Non-fatal deploy advisories returned to the CLI. `missingEnv` lists env var
 * names referenced via `env.NAME` in agent config but not yet stored for the
 * environment, so the operator can run `filthy-panty env set <NAME>`.
 */
const warningsValidator = v.object({
    missingEnv: v.array(v.string()),
});

type CliResource = CliManifestResource;
type Ids = GeneratedIds;

export const getManifestBySecretHash = internalQuery({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
    },
    returns: v.union(v.null(), v.object({ manifest: v.any(), ids: idsValidator })),
    handler: async (ctx, args) => {
        const { secretHash, project, environment } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) return null;
        const resolved = await getProjectEnvironment(ctx, account, project, environment);
        if (!resolved) return null;
        const { projectDoc, environmentDoc } = resolved;
        const ids = await idsForEnvironment(ctx, account._id, projectDoc._id, environmentDoc._id);
        const resources = await resourcesForEnvironment(ctx, account._id, projectDoc._id, environmentDoc._id);

        return {
            manifest: {
                version: 1,
                project: project,
                environment: environment,
                resources: resources,
            },
            ids: ids,
        };
    },
});

/**
 * Resolves a CLI Bearer token hash to the account secret hash it authorizes with.
 * The org Bearer secret grants full account access (`scoped: false`); a project +
 * environment deploy key grants access only when the route resolves to the exact
 * project/environment the key is bound to (`scoped: true`). Returns null when the
 * token is unknown, revoked, or out of scope.
 */
export const resolveCliAuth = internalQuery({
    args: { tokenHash: v.string(), project: v.string(), environment: v.string() },
    returns: v.union(v.null(), v.object({
        accountId: v.id("accounts"),
        secretHash: v.string(),
        scoped: v.boolean(),
        deployKeyId: v.optional(v.id("deployKeys")),
    })),
    handler: async (ctx, args) => {
        const { tokenHash, project, environment } = args;

        // Org Bearer secret → full account access.
        const account = await accountFromSecretHash(ctx, tokenHash);
        if (account) return { accountId: account._id, secretHash: tokenHash, scoped: false };

        // Scoped deploy key → only valid for its bound project + environment.
        const deployKey = await ctx.db
            .query("deployKeys")
            .withIndex("by_keyHash", (q) => q.eq("keyHash", tokenHash))
            .unique();
        if (!deployKey || deployKey.status !== "active") return null;

        const keyAccount = await ctx.db.get(deployKey.accountId);
        if (!keyAccount || keyAccount.status !== "active") return null;

        const resolved = await getProjectEnvironment(ctx, keyAccount, project, environment);
        if (
            !resolved ||
            resolved.projectDoc._id !== deployKey.projectId ||
            resolved.environmentDoc._id !== deployKey.environmentId
        ) {
            return null;
        }

        return {
            accountId: keyAccount._id,
            secretHash: keyAccount.secretHash,
            scoped: true,
            deployKeyId: deployKey._id,
        };
    },
});

export const syncManifestBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        manifest: manifestValidator,
        prune: v.optional(v.boolean()),
    },
    returns: v.object({ manifest: v.any(), ids: idsValidator, warnings: warningsValidator }),
    handler: async (ctx, args) => {
        const { secretHash, manifest, prune } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        assertSupportedWorkspaceSandboxMounts(manifest.resources);

        const projectDoc = await ensureProject(ctx, account, manifest.project);
        const environmentDoc = await ensureEnvironment(ctx, projectDoc, manifest.environment);
        const workspaceIds = await syncWorkspaceResources(ctx, account._id, projectDoc._id, environmentDoc._id, manifest.resources);
        const envValues = await loadEnvironmentVariableValues(ctx, projectDoc._id, environmentDoc._id);
        const missingEnv = new Set<string>();
        const sandboxIds = await syncSandboxResources(ctx, {
            accountId: account._id,
            projectId: projectDoc._id,
            environmentId: environmentDoc._id,
            resources: manifest.resources,
            envValues: envValues,
            missingEnv: missingEnv,
        });
        const agentIds = await syncAgentResources(ctx, {
            account: account,
            projectId: projectDoc._id,
            environmentId: environmentDoc._id,
            resources: manifest.resources,
            workspaceIds: workspaceIds,
            sandboxIds: sandboxIds,
            envValues: envValues,
            missingEnv: missingEnv,
        });

        if (prune === true) {
            await pruneAgents(ctx, projectDoc._id, environmentDoc._id, manifest.resources);
            await pruneWorkspaceResources(ctx, environmentDoc._id, manifest.resources);
            await pruneSandboxResources(ctx, environmentDoc._id, manifest.resources);
        }

        await syncCanvasLayoutForManifest(ctx, {
            account: account,
            projectId: projectDoc._id,
            environmentId: environmentDoc._id,
            resources: manifest.resources,
            workspaceIds: workspaceIds,
            sandboxIds: sandboxIds,
        });

        await ctx.db.patch(projectDoc._id, { updatedAt: Date.now() });
        const externalIds = await externalIdsForEnvironment(ctx, projectDoc._id, environmentDoc._id);
        const ids: Ids = {
            agents: agentIds,
            workspaces: workspaceIds,
            sandboxes: sandboxIds,
            crons: {},
            skills: externalIds.skills,
            tools: externalIds.tools,
        };
        const resources = await resourcesForEnvironment(ctx, account._id, projectDoc._id, environmentDoc._id);

        return {
            manifest: {
                version: 1,
                project: manifest.project,
                environment: manifest.environment,
                resources: resources,
            },
            ids: ids,
            warnings: { missingEnv: [...missingEnv].sort() },
        };
    },
});

/**
 * Ensure the synced environment has a runtime API key (`fp_agent_…`) so the CLI
 * can write `FILTHY_PANTY_API_KEY` into `.env.local`. Returns the plaintext only
 * when freshly minted (reveal-once); otherwise just the masked hint/endpoint.
 */
export const ensureRuntimeKeyBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        rotate: v.optional(v.boolean()),
    },
    returns: v.union(v.null(), v.object({
        accountId: v.id("accounts"),
        endpointId: v.string(),
        projectSlug: v.string(),
        environmentSlug: v.string(),
        keyHint: v.string(),
        apiKey: v.union(v.string(), v.null()),
    })),
    handler: async (ctx, args) => {
        const account = await accountFromSecretHash(ctx, args.secretHash);
        if (!account) return null;
        const resolved = await getProjectEnvironment(ctx, account, args.project, args.environment);
        if (!resolved) return null;
        const { projectDoc, environmentDoc } = resolved;
        const result = await ensureEnvironmentDeployment(ctx, {
            authId: projectDoc.authId,
            accountId: account._id,
            projectId: projectDoc._id,
            environmentId: environmentDoc._id,
            projectSlug: projectDoc.slug ?? resourceName(args.project),
            environmentSlug: environmentDoc.name.toLowerCase(),
            rotate: args.rotate === true,
        });

        return {
            accountId: account._id,
            endpointId: result.endpointId,
            projectSlug: result.projectSlug,
            environmentSlug: result.environmentSlug,
            keyHint: result.keyHint,
            apiKey: result.rawApiKey,
        };
    },
});

export const recordExternalResourcesBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        resources: v.array(resourceValidator),
        ids: v.object({
            skills: v.record(v.string(), v.string()),
            tools: v.record(v.string(), v.string()),
        }),
        prune: v.optional(v.boolean()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const account = await accountFromSecretHash(ctx, args.secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const projectDoc = await ensureProject(ctx, account, args.project);
        const environmentDoc = await ensureEnvironment(ctx, projectDoc, args.environment);
        const existing = await ctx.db
            .query("cliExternalResources")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectDoc._id).eq("environmentId", environmentDoc._id),
            )
            .collect();
        const desired = args.resources.filter((entry) => entry.kind === "skill" || entry.kind === "tool");
        const desiredKeys = new Set(desired.map((entry) => `${entry.kind}:${resourceName(entry.name)}`));

        for (const resource of desired) {
            const name = resourceName(resource.name);
            const kind: "skill" | "tool" = resource.kind === "skill" ? "skill" : "tool";
            const externalId = resource.kind === "skill" ? args.ids.skills[name] : args.ids.tools[name];
            if (!externalId) throw new Error(`${resource.kind}:${name} did not return an external id`);
            const current = existing.find((entry) => entry.kind === kind && entry.name === name);
            const row = {
                accountId: account._id,
                projectId: projectDoc._id,
                environmentId: environmentDoc._id,
                kind: kind,
                name: name,
                description: resource.description,
                externalId: externalId,
                config: snapshotExternalConfig(resource.config),
                updatedAt: Date.now(),
            };
            if (current) await ctx.db.patch(current._id, row);
            else await ctx.db.insert("cliExternalResources", row);
        }

        if (args.prune === true) {
            for (const resource of existing) {
                if (!desiredKeys.has(`${resource.kind}:${resource.name}`)) await ctx.db.delete(resource._id);
            }
        }

        return null;
    },
});

/**
 * Replaces the dashboard file tree for a CLI-managed skill node with uploaded bundle files.
 */
export const replaceSkillNodeFilesBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        skillName: v.string(),
        files: v.array(v.object({
            path: v.string(),
            name: v.string(),
            storageId: v.id("_storage"),
            mimeType: v.optional(v.string()),
            sizeBytes: v.optional(v.number()),
        })),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const account = await accountFromSecretHash(ctx, args.secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const resolved = await getProjectEnvironment(ctx, account, args.project, args.environment);
        if (!resolved) throw new Error("Project or environment not found");
        const authId = await authIdForAccount(ctx, account);
        if (!authId) throw new Error("Account org owner not found");
        const nodeId = canvasNodeId("skill", resourceName(args.skillName));

        const existing = await ctx.db
            .query("workspaceFiles")
            .withIndex("by_projectId_and_nodeId", (q) =>
                q.eq("projectId", resolved.projectDoc._id).eq("nodeId", nodeId),
            )
            .collect();
        for (const file of existing) {
            if (file.storageId) await ctx.storage.delete(file.storageId);
            await ctx.db.delete(file._id);
        }

        const now = Date.now();
        for (const file of args.files) {
            await ctx.db.insert("workspaceFiles", {
                authId: authId,
                projectId: resolved.projectDoc._id,
                nodeId: nodeId,
                path: file.path,
                name: file.name,
                isFolder: false,
                storageId: file.storageId,
                mimeType: file.mimeType,
                sizeBytes: file.sizeBytes,
                createdAt: now,
                updatedAt: now,
            });
        }

        return null;
    },
});

export const deleteResourceBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        kind: v.union(v.literal("agent"), v.literal("workspace"), v.literal("sandbox")),
        name: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { secretHash, project, environment, kind, name } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const resolved = await getProjectEnvironment(ctx, account, project, environment);
        if (!resolved) throw new Error("Project/environment not found");
        const normalizedName = resourceName(name);

        if (kind === "agent") {
            await deleteAgentResource(ctx, resolved.projectDoc._id, resolved.environmentDoc._id, normalizedName);
        } else if (kind === "workspace") {
            await deleteWorkspaceResource(ctx, resolved.environmentDoc._id, normalizedName);
        } else {
            await deleteSandboxResource(ctx, resolved.environmentDoc._id, normalizedName);
        }

        await ctx.db.patch(resolved.projectDoc._id, { updatedAt: Date.now() });
        return null;
    },
});

export const setEnvBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        name: v.string(),
        value: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const { secretHash, project, environment, name, value } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const projectDoc = await ensureProject(ctx, account, project);
        const environmentDoc = await ensureEnvironment(ctx, projectDoc, environment);
        const normalizedName = envName(name);
        const existing = await ctx.db
            .query("environmentVariables")
            .withIndex("by_environmentId_and_name", (q) =>
                q.eq("environmentId", environmentDoc._id).eq("name", normalizedName),
            )
            .unique();
        const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
        if (!secret) {
            throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store environment variables");
        }
        const encrypted = await encryptAgentConfigBlob({ value: value }, secret);
        const now = Date.now();

        if (existing) {
            await ctx.db.patch(existing._id, {
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                tag: encrypted.tag,
                updatedAt: now,
            });
        } else {
            await ctx.db.insert("environmentVariables", {
                projectId: projectDoc._id,
                environmentId: environmentDoc._id,
                name: normalizedName,
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                tag: encrypted.tag,
                updatedAt: now,
            });
        }
        await refreshAgentConfigsForEnvironmentVariable(
            ctx,
            projectDoc._id,
            environmentDoc._id,
            normalizedName,
            value,
        );
        await refreshSandboxConfigsForEnvironmentVariable(
            ctx,
            projectDoc._id,
            environmentDoc._id,
            normalizedName,
            value,
        );

        return null;
    },
});

/**
 * Lists the names (and last-updated times) of an environment's stored variables
 * for the CLI `env list`. Values are never returned — they are encrypted at rest
 * and write-only by design, so the dashboard and CLI only ever see the names.
 */
export const listEnvBySecretHash = internalQuery({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
    },
    returns: v.array(v.object({ name: v.string(), updatedAt: v.number() })),
    handler: async (ctx, args) => {
        const { secretHash, project, environment } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const resolved = await getProjectEnvironment(ctx, account, project, environment);
        if (!resolved) return [];

        const variables = await ctx.db
            .query("environmentVariables")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", resolved.projectDoc._id).eq("environmentId", resolved.environmentDoc._id),
            )
            .collect();

        return variables
            .map((variable) => ({ name: variable.name, updatedAt: variable.updatedAt }))
            .sort((a, b) => a.name.localeCompare(b.name));
    },
});

/**
 * Decrypts and returns one environment variable's plaintext value for the CLI
 * `env get`, writing an audit record of the reveal. A mutation (not a query) so
 * decryption and the audit insert happen together. Returns null when the
 * project/environment or the named variable does not exist.
 */
export const getEnvBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        name: v.string(),
        revealedByCliTokenId: v.optional(v.id("cliTokens")),
        revealedByCliAuthId: v.optional(v.string()),
        revealedByDeployKeyId: v.optional(v.id("deployKeys")),
    },
    returns: v.union(v.null(), v.object({ value: v.string() })),
    handler: async (ctx, args) => {
        const { secretHash, project, environment, name } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const resolved = await getProjectEnvironment(ctx, account, project, environment);
        if (!resolved) return null;
        const normalizedName = envName(name);

        const existing = await ctx.db
            .query("environmentVariables")
            .withIndex("by_environmentId_and_name", (q) =>
                q.eq("environmentId", resolved.environmentDoc._id).eq("name", normalizedName),
            )
            .unique();
        if (!existing) return null;

        const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
        if (!secret) {
            throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to read environment variables");
        }
        const decrypted = await decryptAgentConfigBlob(
            { ciphertext: existing.ciphertext, iv: existing.iv, tag: existing.tag },
            secret,
        );
        const revealed = decrypted as { value?: unknown } | null;
        const value = typeof revealed?.value === "string" ? revealed.value : "";

        await ctx.db.insert("environmentVariableReveals", {
            projectId: resolved.projectDoc._id,
            environmentId: resolved.environmentDoc._id,
            environmentVariableId: existing._id,
            name: normalizedName,
            source: "cli",
            revealedByAccountId: account._id,
            revealedByCliTokenId: args.revealedByCliTokenId,
            revealedByCliAuthId: args.revealedByCliAuthId,
            revealedByDeployKeyId: args.revealedByDeployKeyId,
            revealedAt: Date.now(),
        });

        return { value: value };
    },
});

/**
 * Removes one environment variable by name for the CLI `env rm`. Resolving the
 * project/environment is required; a missing variable is treated as success so
 * the command is idempotent.
 */
export const removeEnvBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        name: v.string(),
    },
    returns: v.object({ removed: v.boolean() }),
    handler: async (ctx, args) => {
        const { secretHash, project, environment, name } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");
        const resolved = await getProjectEnvironment(ctx, account, project, environment);
        if (!resolved) throw new Error("Project/environment not found");
        const normalizedName = envName(name);

        const existing = await ctx.db
            .query("environmentVariables")
            .withIndex("by_environmentId_and_name", (q) =>
                q.eq("environmentId", resolved.environmentDoc._id).eq("name", normalizedName),
            )
            .unique();
        if (!existing) return { removed: false };

        await ctx.db.delete(existing._id);
        await refreshAgentConfigsForEnvironmentVariable(
            ctx,
            resolved.projectDoc._id,
            resolved.environmentDoc._id,
            normalizedName,
            undefined,
        );
        await refreshSandboxConfigsForEnvironmentVariable(
            ctx,
            resolved.projectDoc._id,
            resolved.environmentDoc._id,
            normalizedName,
            undefined,
        );

        return { removed: true };
    },
});

async function accountFromSecretHash(
    ctx: QueryCtx | MutationCtx,
    secretHash: string,
) {
    const account = await ctx.db
        .query("accounts")
        .withIndex("by_secretHash", (q) => q.eq("secretHash", secretHash))
        .unique();
    if (!account || account.status !== "active") return null;

    return account;
}

async function getProjectEnvironment(
    ctx: QueryCtx | MutationCtx,
    account: Doc<"accounts">,
    project: string,
    environment: string,
) {
    const orgId = ctx.db.normalizeId("orgs", account.orgId);
    if (!orgId) return null;
    const projects = await ctx.db
        .query("projects")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect();
    const normalizedProject = resourceName(project);
    const projectDoc = projects.find((entry) =>
        entry.name === normalizedProject || entry.slug === normalizedProject,
    );
    if (!projectDoc) return null;
    const environments = await ctx.db
        .query("environments")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
        .collect();
    const normalizedEnvironment = resourceName(environment);
    const environmentDoc = environments.find((entry) => environmentNameEquals(entry.name, normalizedEnvironment));
    if (!environmentDoc) return null;

    return { projectDoc: projectDoc, environmentDoc: environmentDoc };
}

async function ensureProject(
    ctx: MutationCtx,
    account: Doc<"accounts">,
    project: string,
) {
    const orgId = ctx.db.normalizeId("orgs", account.orgId);
    if (!orgId) throw new Error("Account is not linked to a valid org");
    const org = await ctx.db.get(orgId);
    if (!org) throw new Error("Account org not found");

    const existing = await ctx.db
        .query("projects")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect();
    const name = resourceName(project);
    const projectDoc = existing.find((entry) => entry.name === name || entry.slug === name);
    if (projectDoc) return projectDoc;

    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
        authId: org.ownerAuthId,
        orgId: orgId,
        name: name,
        slug: await uniqueProjectSlug(ctx, org.ownerAuthId, name),
        updatedAt: now,
    });
    const created = await ctx.db.get(projectId);
    if (!created) throw new Error("Failed to create project");

    // Seed a Development default so the dashboard lands on Development even when
    // the first CLI command deploys straight to Production.
    await ctx.db.insert("environments", {
        authId: org.ownerAuthId,
        projectId: projectId,
        name: "Development",
        kind: "development",
        isDefault: true,
        updatedAt: now,
    });

    return created;
}

async function ensureEnvironment(
    ctx: MutationCtx,
    project: Doc<"projects">,
    environment: string,
) {
    const environments = await ctx.db
        .query("environments")
        .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
        .collect();
    const name = resourceName(environment);
    const existing = environments.find((entry) => environmentNameEquals(entry.name, name));
    const kind = environmentKindForName(name);
    if (existing) {
        if (existing.kind !== kind || existing.name !== displayEnvironmentName(name)) {
            await ctx.db.patch(existing._id, {
                name: displayEnvironmentName(name),
                kind: kind,
                isDefault: kind === "development" ? true : existing.isDefault,
                updatedAt: Date.now(),
            });
        }
        if (kind === "development") {
            for (const environment of environments.filter((entry) => entry._id !== existing._id && entry.isDefault)) {
                await ctx.db.patch(environment._id, { isDefault: false, updatedAt: Date.now() });
            }
        }

        return existing;
    }

    // Only Development is ever the default; Production/custom environments are
    // never auto-defaulted, even when created first.
    const environmentId = await ctx.db.insert("environments", {
        authId: project.authId,
        projectId: project._id,
        name: displayEnvironmentName(name),
        kind: kind,
        isDefault: kind === "development",
        updatedAt: Date.now(),
    });
    const created = await ctx.db.get(environmentId);
    if (!created) throw new Error("Failed to create environment");
    if (kind === "development") {
        for (const environment of environments.filter((entry) => entry.isDefault)) {
            await ctx.db.patch(environment._id, { isDefault: false, updatedAt: Date.now() });
        }
    }

    return created;
}

async function syncWorkspaceResources(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
    resources: CliResource[],
): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    const existing = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const workspaceResources = resources.filter((entry) => entry.kind === "workspace");
    const desiredNames = new Set(workspaceResources.map((entry) => resourceName(entry.name)));
    const claimed = new Set<Id<"workspaceConfigs">>();
    for (const resource of workspaceResources) {
        assertSupportedWorkspaceStorage(resource);
        const name = resourceName(resource.name);
        const current = existing.find((entry) => entry.name === name);
        const target = current ?? existing.find((entry) =>
            entry.managedBy === "cli" &&
            !claimed.has(entry._id) &&
            !desiredNames.has(entry.name) &&
            stableJson(renameComparableResource(entry.description, entry.config)) ===
            stableJson(renameComparableResource(resource.description, resource.config))
        );
        if (target) {
            claimed.add(target._id);
            await ctx.db.patch(target._id, {
                accountId: accountId,
                projectId: projectId,
                name: name,
                description: resource.description,
                config: resource.config,
                managedBy: "cli",
                updatedAt: Date.now(),
            });
            ids[name] = target._id;
        } else {
            await assertNoAccountScopedResourceConflict(ctx, {
                table: "workspaceConfigs",
                accountId: accountId,
                name: name,
            });
            const now = Date.now();
            const id = await ctx.db.insert("workspaceConfigs", {
                accountId: accountId,
                projectId: projectId,
                environmentId: environmentId,
                name: name,
                description: resource.description,
                config: resource.config,
                managedBy: "cli",
                createdAt: now,
                updatedAt: now,
            });
            ids[name] = id;
        }
    }

    return ids;
}

function assertSupportedWorkspaceStorage(resource: CliResource): void {
    const config = plainRecord(resource.config);
    const storage = plainRecord(config.storage);
    const provider = storage.provider;
    if (provider === undefined || provider === "s3") return;
    if (provider === "vercel") {
        throw new Error(
            `Workspace "${resource.name}" uses storage.provider "vercel", but Vercel Drive workspace storage is not supported yet. ` +
            `Use storage.provider "s3" or omit storage until Vercel Drive is wired.`,
        );
    }
    throw new Error(`Workspace "${resource.name}" config.storage.provider must be one of: s3`);
}

function plainRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertSupportedWorkspaceSandboxMounts(resources: CliResource[]): void {
    const sandboxes = new Map(resources.filter((entry) => entry.kind === "sandbox").map((entry) => [entry.name, entry]));
    for (const agent of resources.filter((entry) => entry.kind === "agent")) {
        const config = plainRecord(agent.config);
        const agentSandbox = typeof config.sandbox === "string" ? sandboxes.get(config.sandbox) : undefined;
        const workspaces = config.workspaces;
        if (!Array.isArray(workspaces)) continue;
        for (const ref of workspaces) {
            const workspace = plainRecord(ref);
            const sandboxName = workspace.sandbox === null
                ? undefined
                : typeof workspace.sandbox === "string"
                    ? workspace.sandbox
                    : typeof config.sandbox === "string"
                        ? config.sandbox
                        : undefined;
            if (!sandboxName) continue;
            const sandbox = sandboxes.get(sandboxName);
            if (!sandbox || supportsS3WorkspaceMount(sandbox)) continue;
            throw new Error(
                `Agent "${agent.name}" workspace "${String(workspace.name ?? workspace.workspaceId ?? "<unknown>")}" uses sandbox "${sandbox.name}" ` +
                `(${sandboxProvider(sandbox)}) which does not support S3 workspace mounts. Use lambda, or daytona/kubernetes with ` +
                `options.mountAwsS3Buckets: true, or set this workspace ref to sandbox: null for read-only S3 access.`,
            );
        }
    }
}

function supportsS3WorkspaceMount(sandbox: CliResource): boolean {
    const provider = sandboxProvider(sandbox);
    if (provider === "lambda") return true;
    if (provider !== "daytona" && provider !== "kubernetes") return false;
    return plainRecord(plainRecord(sandbox.config).options).mountAwsS3Buckets === true;
}

function sandboxProvider(sandbox: CliResource): string {
    const provider = plainRecord(sandbox.config).provider;
    return typeof provider === "string" ? provider : "lambda";
}

async function syncSandboxResources(
    ctx: MutationCtx,
    options: {
        accountId: Id<"accounts">;
        projectId: Id<"projects">;
        environmentId: Id<"environments">;
        resources: CliResource[];
        envValues: Record<string, string>;
        missingEnv: Set<string>;
    },
): Promise<Record<string, string>> {
    const { accountId, projectId, environmentId, resources, envValues, missingEnv } = options;
    const ids: Record<string, string> = {};
    const sandboxes = resources.filter((entry) => entry.kind === "sandbox");
    if (sandboxes.length === 0) return ids;

    // sandboxConfigs is a shared SaaS table owned by filthy-panty: the blob is
    // stored encrypted at rest (envVars/options may carry provider secrets).
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to sync sandbox configs");
    }
    const existing = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const desiredNames = new Set(sandboxes.map((entry) => resourceName(entry.name)));
    const existingConfigs = new Map<Id<"sandboxConfigs">, Record<string, unknown>>();
    for (const sandbox of existing) {
        existingConfigs.set(sandbox._id, await decryptSandboxConfig(sandbox, secret));
    }
    const claimed = new Set<Id<"sandboxConfigs">>();

    for (const resource of sandboxes) {
        const name = resourceName(resource.name);
        // Resolve `env.NAME` refs to their stored values before encrypting, the
        // same way agent configs are resolved at sync time — core reads the
        // sandbox blob verbatim and has no placeholder substitution of its own.
        // Missing names surface as a deploy warning instead of leaking a literal
        // `${NAME}` into the sandbox environment. The resolved form is also what
        // the rename comparison runs on, since `existingConfigs` is resolved too.
        const envNames = new Set<string>();
        // `sourceConfig` keeps `${NAME}` placeholders; `resolvedConfig` bakes in
        // current values. We store both: resolved for core to read, source so
        // `refreshSandboxConfigsForEnvironmentVariable` can re-resolve on a later
        // env-var change without a CLI re-sync (parity with agent configs).
        const sourceConfig = rewriteEnvRefs(asObject(resource.config), envNames);
        const resolvedConfig = substituteEnvPlaceholders(sourceConfig, envValues);
        for (const envNameEntry of envNames) {
            if (envValues[envNameEntry] === undefined) missingEnv.add(envNameEntry);
        }
        const runtimeVariables = [...envNames].map((key) => ({ key: key, value: "" }));
        const encrypted = await encryptAgentConfigBlob(resolvedConfig, secret);
        const encryptedSource = await encryptAgentConfigBlob(sourceConfig, secret);
        const current = existing.find((entry) => entry.name === name);
        const target = current ?? existing.find((entry) =>
            entry.managedBy === "cli" &&
            !claimed.has(entry._id) &&
            !desiredNames.has(entry.name) &&
            stableJson(renameComparableResource(entry.description, existingConfigs.get(entry._id) ?? {})) ===
            stableJson(renameComparableResource(resource.description, resolvedConfig))
        );
        if (target) {
            claimed.add(target._id);
            await ctx.db.patch(target._id, {
                accountId: accountId,
                projectId: projectId,
                name: name,
                description: resource.description,
                encryptedConfig: encrypted.ciphertext,
                encryptionIv: encrypted.iv,
                encryptionTag: encrypted.tag,
                encryptedSourceConfig: encryptedSource.ciphertext,
                sourceEncryptionIv: encryptedSource.iv,
                sourceEncryptionTag: encryptedSource.tag,
                runtimeVariables: runtimeVariables,
                managedBy: "cli",
                updatedAt: Date.now(),
            });
            ids[name] = target._id;
        } else {
            await assertNoAccountScopedResourceConflict(ctx, {
                table: "sandboxConfigs",
                accountId: accountId,
                name: name,
            });
            const now = Date.now();
            const id = await ctx.db.insert("sandboxConfigs", {
                accountId: accountId,
                projectId: projectId,
                environmentId: environmentId,
                name: name,
                description: resource.description,
                encryptedConfig: encrypted.ciphertext,
                encryptionIv: encrypted.iv,
                encryptionTag: encrypted.tag,
                encryptedSourceConfig: encryptedSource.ciphertext,
                sourceEncryptionIv: encryptedSource.iv,
                sourceEncryptionTag: encryptedSource.tag,
                runtimeVariables: runtimeVariables,
                managedBy: "cli",
                createdAt: now,
                updatedAt: now,
            });
            ids[name] = id;
        }
    }

    return ids;
}

/**
 * Fail loudly when an old account-scoped runtime resource would shadow the new
 * environment-scoped row. Operators must migrate or delete that row explicitly.
 */
async function assertNoAccountScopedResourceConflict(
    ctx: MutationCtx,
    options: {
        table: "workspaceConfigs" | "sandboxConfigs";
        accountId: Id<"accounts">;
        name: string;
    },
): Promise<void> {
    const rows = await ctx.db
        .query(options.table)
        .withIndex("by_accountId_and_name", (q) =>
            q.eq("accountId", options.accountId).eq("name", options.name),
        )
        .collect();
    const accountScoped = rows.find((row) => row.environmentId === undefined);
    if (!accountScoped) return;

    throw new Error(
        `${options.table} "${options.name}" is account-scoped legacy data. ` +
        "Migrate it to a project/environment or delete it before syncing code-managed resources.",
    );
}

async function syncAgentResources(
    ctx: MutationCtx,
    options: {
        account: Doc<"accounts">;
        projectId: Id<"projects">;
        environmentId: Id<"environments">;
        resources: CliResource[];
        workspaceIds: Record<string, string>;
        sandboxIds: Record<string, string>;
        envValues: Record<string, string>;
        missingEnv: Set<string>;
    },
): Promise<Record<string, string>> {
    const { account, projectId, environmentId, resources, workspaceIds, sandboxIds, envValues, missingEnv } = options;
    const ids: Record<string, string> = {};
    // Agents whose `subagent.allowed` references other agents by name. Resolved
    // to deploy-time agent ids in a second pass, once every agent row exists.
    const pendingSubagentRefs: Array<{ configId: Id<"agentConfigs">; nested: Record<string, unknown> }> = [];
    const existing = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const agentResources = resources.filter((entry) => entry.kind === "agent");
    const desiredNames = new Set(agentResources.map((entry) => resourceName(entry.name)));
    const existingSnapshots = new Map<Id<"agentConfigs">, string>();
    for (const config of existing) {
        existingSnapshots.set(config._id, stableJson(renameComparableAgent(config)));
    }
    const claimed = new Set<Id<"agentConfigs">>();

    for (const resource of agentResources) {
        const name = resourceName(resource.name);
        const envNames = new Set<string>();
        const nested = rewriteResourceRefs(
            rewriteEnvRefs(asObject(resource.config), envNames),
            workspaceIds,
            sandboxIds,
        );
        const flat = fromNestedAgentConfig(nested);
        // Names referenced via `env.NAME` but not yet stored for this environment.
        // Surfaced as a deploy warning so a typo/rename can't silently no-op into
        // an unresolved `${NAME}` placeholder at run time.
        for (const envNameEntry of envNames) {
            if (envValues[envNameEntry] === undefined) missingEnv.add(envNameEntry);
        }
        const runtimeVariables = [...envNames]
            .filter((envNameEntry) => envValues[envNameEntry] !== undefined)
            .map((envNameEntry) => ({ key: envNameEntry, value: envValues[envNameEntry] }));
        const current = existing.find((entry) => entry.name === name);
        const target = current ?? existing.find((entry) =>
            entry.managedBy === "cli" &&
            !claimed.has(entry._id) &&
            !desiredNames.has(entry.name) &&
            existingSnapshots.get(entry._id) === stableJson(renameComparableResource(resource.description, nested))
        );
        if (target) {
            claimed.add(target._id);
            const publicRuntimeVariables = await saveAgentRuntimeSecrets(
                ctx,
                target._id,
                runtimeVariables,
            );
            await ctx.db.patch(target._id, {
                name: name,
                description: resource.description,
                provider: flat.provider,
                modelId: flat.modelId,
                systemPrompt: flat.systemPrompt,
                maxTurns: flat.maxTurns,
                temperature: flat.temperature,
                maxTokens: flat.maxTokens,
                providerOptions: flat.providerOptions,
                outputFormat: flat.outputFormat,
                searchToolEnabled: flat.searchToolEnabled,
                searchToolConfig: flat.searchToolConfig,
                runtimeVariables: publicRuntimeVariables,
                extraConfig: flat.extraConfig,
                managedBy: "cli",
                updatedAt: Date.now(),
            });
            await ensureAgentsRowForConfig(ctx, target._id, target.authId);
            await syncAgentRowFields(ctx, target._id, {
                name: name,
                description: resource.description,
            });
            await pushEncryptedConfigToAgentRow(ctx, target._id);
            const refreshed = await ctx.db.get(target._id);
            if (refreshed?.agentId) ids[name] = refreshed.agentId;
            if (hasSubagentAllowed(nested)) pendingSubagentRefs.push({ configId: target._id, nested: nested });
        } else {
            const authId = await authIdForAccount(ctx, account);
            if (!authId) throw new Error("Account org owner not found");
            const configId = await ctx.db.insert("agentConfigs", {
                authId: authId,
                name: name,
                description: resource.description,
                projectId: projectId,
                environmentId: environmentId,
                provider: flat.provider,
                modelId: flat.modelId,
                systemPrompt: flat.systemPrompt,
                maxTurns: flat.maxTurns,
                temperature: flat.temperature,
                maxTokens: flat.maxTokens,
                providerOptions: flat.providerOptions,
                outputFormat: flat.outputFormat,
                searchToolEnabled: flat.searchToolEnabled,
                searchToolConfig: flat.searchToolConfig,
                runtimeVariables: runtimeVariables.map((entry) => ({ key: entry.key, value: "" })),
                extraConfig: flat.extraConfig,
                managedBy: "cli",
                updatedAt: Date.now(),
            });
            await saveAgentRuntimeSecrets(ctx, configId, runtimeVariables);
            await ensureAgentsRowForConfig(ctx, configId, authId);
            await pushEncryptedConfigToAgentRow(ctx, configId);
            const created = await ctx.db.get(configId);
            if (created?.agentId) ids[name] = created.agentId;
            if (hasSubagentAllowed(nested)) pendingSubagentRefs.push({ configId: configId, nested: nested });
        }
    }

    await resolveSubagentReferences(ctx, pendingSubagentRefs, ids);

    return ids;
}

/** True when an agent's nested config lists other agents in `subagent.allowed`. */
function hasSubagentAllowed(nested: Record<string, unknown>): boolean {
    const subagent = nested.subagent;

    return isRecord(subagent) && Array.isArray(subagent.allowed) && subagent.allowed.length > 0;
}

/**
 * Second pass over agents that reference other agents in `subagent.allowed`.
 * Rewrites declared agent names to their deploy-time agent ids (leaving any
 * non-declared string, e.g. a literal agent id, untouched) and re-pushes the
 * encrypted config so the runtime can dispatch the named subagents.
 */
async function resolveSubagentReferences(
    ctx: MutationCtx,
    pending: Array<{ configId: Id<"agentConfigs">; nested: Record<string, unknown> }>,
    agentIds: Record<string, string>,
): Promise<void> {
    for (const { configId, nested } of pending) {
        const subagent = nested.subagent as Record<string, unknown>;
        const allowed = (subagent.allowed as unknown[]).map((entry) =>
            typeof entry === "string" && agentIds[entry] ? agentIds[entry] : entry,
        );
        const resolved = { ...nested, subagent: { ...subagent, allowed: allowed } };
        const flat = fromNestedAgentConfig(resolved);
        await ctx.db.patch(configId, { extraConfig: flat.extraConfig, updatedAt: Date.now() });
        await pushEncryptedConfigToAgentRow(ctx, configId);
    }
}

type CanvasNode = {
    id: string;
    type: "agent" | "database" | "sandbox" | "workspace" | "tool" | "skill";
    position: { x: number; y: number };
    data: Record<string, unknown>;
};

type CanvasEdge = {
    id: string;
    source: string;
    target: string;
    animated?: boolean;
};

type CanvasCliResource = CliResource & {
    kind: "agent" | "workspace" | "sandbox" | "skill";
};

async function syncCanvasLayoutForManifest(
    ctx: MutationCtx,
    options: {
        account: Doc<"accounts">;
        projectId: Id<"projects">;
        environmentId: Id<"environments">;
        resources: CliResource[];
        workspaceIds: Record<string, string>;
        sandboxIds: Record<string, string>;
    },
): Promise<void> {
    const { account, projectId, environmentId, resources, workspaceIds, sandboxIds } = options;
    const layout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .unique();
    const existingNodes = ((layout?.nodes ?? []) as CanvasNode[]).map(normalizeCanvasNode);
    const existingEdges = ((layout?.edges ?? []) as CanvasEdge[]).map(normalizeCanvasEdge);
    const existingByAgentConfigId = new Map<string, CanvasNode>();
    const existingByResourceId = new Map<string, CanvasNode>();
    const existingById = new Map<string, CanvasNode>();
    for (const node of existingNodes) {
        existingById.set(node.id, node);
        const data = isRecord(node.data) ? node.data : {};
        if (typeof data.agentConfigId === "string") existingByAgentConfigId.set(data.agentConfigId, node);
        if (typeof data.resourceId === "string") existingByResourceId.set(data.resourceId, node);
    }

    const agentConfigs = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const agentConfigByName = new Map(agentConfigs.map((entry) => [entry.name, entry]));
    const desiredResources: CanvasCliResource[] = resources
        .filter((entry): entry is CanvasCliResource =>
            entry.kind === "agent" || entry.kind === "workspace" || entry.kind === "sandbox" || entry.kind === "skill",
        )
        .map((entry) => ({ ...entry, name: resourceName(entry.name) }));
    const desiredNodeKeys = new Set(desiredResources.map((entry) => `${entry.kind}:${entry.name}`));
    const desiredEdges = new Map<string, CanvasEdge>();
    const nextById = new Map(existingNodes.map((node) => [node.id, node]));
    const nodeIdByKindName = new Map<string, string>();

    const ordered = [...desiredResources].sort((a, b) => {
        const rank = { agent: 0, sandbox: 1, workspace: 2, skill: 3 } as const;
        return rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name);
    });
    ordered.forEach((resource, index) => {
        if (resource.kind === "agent") {
            const config = agentConfigByName.get(resource.name);
            if (!config) return;
            const node = upsertCanvasNode({
                nextById,
                existingById,
                preferred: existingByAgentConfigId.get(config._id),
                kind: "agent",
                name: resource.name,
                position: { x: 80, y: 80 + index * 180 },
                data: {
                    label: resource.name,
                    status: "idle",
                    agentConfigId: config._id,
                    managedBy: "cli",
                    cliResourceKey: `agent:${resource.name}`,
                },
            });
            nodeIdByKindName.set(`agent:${resource.name}`, node.id);
            return;
        }

        if (resource.kind === "skill") {
            const configSnapshot = snapshotExternalConfig(resource.config);
            const node = upsertCanvasNode({
                nextById,
                existingById,
                preferred: existingById.get(canvasNodeId("skill", resource.name)),
                kind: "skill",
                name: resource.name,
                position: { x: 760, y: 80 + index * 180 },
                data: {
                    label: resource.name,
                    status: "idle",
                    resourceId: resource.name,
                    description: resource.description,
                    config: {
                        skillSource: "files",
                        ...(isRecord(configSnapshot) ? configSnapshot : {}),
                    },
                    managedBy: "cli",
                    cliResourceKey: `skill:${resource.name}`,
                },
            });
            nodeIdByKindName.set(`skill:${resource.name}`, node.id);
            return;
        }

        const resourceId = resource.kind === "workspace"
            ? workspaceIds[resource.name]
            : sandboxIds[resource.name];
        if (!resourceId) return;
        const node = upsertCanvasNode({
            nextById,
            existingById,
            preferred: existingByResourceId.get(resourceId),
            kind: resource.kind,
            name: resource.name,
            position: {
                x: resource.kind === "sandbox" ? 420 : 760,
                y: 80 + index * 180,
            },
            data: {
                label: resource.name,
                status: "idle",
                resourceId: resourceId,
                mountName: resource.name,
                description: resource.description,
                config: resource.config,
                managedBy: "cli",
                cliResourceKey: `${resource.kind}:${resource.name}`,
            },
        });
        nodeIdByKindName.set(`${resource.kind}:${resource.name}`, node.id);
    });

    // Track each workspace node's effective writability so we can flag read-only
    // workspaces for the canvas badge. The pure-canvas graph can't express
    // `sandbox: null` (the dashboard only emits `sandbox:<id>` or omits it), so the
    // CLI — which sees every agent's refs — resolves it here and stamps the node.
    const workspaceReferenced = new Set<string>();
    const workspaceHasWriter = new Set<string>();

    for (const agent of desiredResources.filter((entry) => entry.kind === "agent")) {
        const agentId = nodeIdByKindName.get(`agent:${agent.name}`);
        if (!agentId || !isRecord(agent.config)) continue;
        // Agent→service edges are default (top/bottom handle) edges, like the
        // dashboard's own auto-connect. Only workspace↔sandbox uses a side-handle
        // mount edge (sandbox x=420 sits left of workspace x=760).
        const agentSandboxName = typeof agent.config.sandbox === "string" ? resourceName(agent.config.sandbox) : null;
        if (agentSandboxName) {
            const sandboxNodeId = nodeIdByKindName.get(`sandbox:${agentSandboxName}`);
            if (sandboxNodeId) addDesiredDefaultEdge(desiredEdges, agentId, sandboxNodeId);
        }

        if (Array.isArray(agent.config.workspaces)) {
            for (const workspaceRef of agent.config.workspaces) {
                if (!isRecord(workspaceRef) || typeof workspaceRef.workspaceId !== "string") continue;
                const workspaceName = resourceName(workspaceRef.workspaceId);
                const workspaceNodeId = nodeIdByKindName.get(`workspace:${workspaceName}`);
                if (!workspaceNodeId) continue;
                addDesiredDefaultEdge(desiredEdges, agentId, workspaceNodeId);
                workspaceReferenced.add(workspaceNodeId);
                if (typeof workspaceRef.sandbox === "string") {
                    // Per-workspace sandbox override → writable, drawn as a mount edge.
                    workspaceHasWriter.add(workspaceNodeId);
                    const sandboxNodeId = nodeIdByKindName.get(`sandbox:${resourceName(workspaceRef.sandbox)}`);
                    if (sandboxNodeId) addDesiredMountEdge(desiredEdges, workspaceNodeId, "left", sandboxNodeId, "right");
                } else if (workspaceRef.sandbox !== null && agentSandboxName) {
                    // Omitted sandbox inherits the agent-level default (writable).
                    // `null` explicitly forces read-only, so it stays a non-writer.
                    workspaceHasWriter.add(workspaceNodeId);
                }
            }
        }

        // Subagent (agent→agent) edges from `subagent.allowed`. The dashboard
        // reconstructs handles + type from the `subagent:` id prefix on load, so the
        // CLI only persists id/source/target — the same way mount edges work.
        const subagent = agent.config.subagent;
        if (isRecord(subagent) && Array.isArray(subagent.allowed)) {
            for (const entry of subagent.allowed) {
                if (typeof entry !== "string" || !entry.trim()) continue;
                const calleeNodeId = nodeIdByKindName.get(`agent:${resourceName(entry)}`);
                if (calleeNodeId && calleeNodeId !== agentId) {
                    addDesiredSubagentEdge(desiredEdges, agentId, calleeNodeId);
                }
            }
        }

        const skills = agent.config.skills;
        if (isRecord(skills) && Array.isArray(skills.allowed)) {
            for (const entry of skills.allowed) {
                if (typeof entry !== "string" || !entry.trim()) continue;
                const skillNodeId = skillNodeIdForReference(nodeIdByKindName, entry);
                if (skillNodeId) addDesiredDefaultEdge(desiredEdges, agentId, skillNodeId);
            }
        }
    }

    // Stamp the resolved read-only state onto each workspace node already in
    // `nextById`. An explicit `false` clears a stale flag once a writer exists.
    for (const [key, nodeId] of nodeIdByKindName) {
        if (!key.startsWith("workspace:")) continue;
        const node = nextById.get(nodeId);
        if (!node) continue;
        node.data = {
            ...node.data,
            readOnly: workspaceReferenced.has(nodeId) && !workspaceHasWriter.has(nodeId),
        };
    }

    const existingEdgeIds = new Set(existingEdges.map((edge) => edge.id));
    const nextEdges = existingEdges.filter((edge) =>
        desiredEdges.has(edge.id) || !edgeIsCliManaged(edge, nextById),
    );
    for (const edge of desiredEdges.values()) {
        if (existingEdgeIds.has(edge.id)) continue;
        nextEdges.push(edge);
    }

    const nextNodes = [...nextById.values()].filter((node) => {
        const key = typeof node.data.cliResourceKey === "string" ? node.data.cliResourceKey : null;
        if (key) return desiredNodeKeys.has(key);
        if (node.id.startsWith("cli-")) return desiredNodeKeys.has(cliResourceKeyForNode(node));
        return true;
    });
    const now = Date.now();
    if (layout) {
        await ctx.db.patch(layout._id, { nodes: nextNodes, edges: nextEdges, updatedAt: now });
    } else if (nextNodes.length > 0) {
        const authId = await authIdForAccount(ctx, account);
        if (!authId) throw new Error("Account org owner not found");
        await ctx.db.insert("canvasLayouts", {
            authId: authId,
            projectId: projectId,
            environmentId: environmentId,
            nodes: nextNodes,
            edges: nextEdges,
            updatedAt: now,
        });
    }
}

function upsertCanvasNode(options: {
    nextById: Map<string, CanvasNode>;
    existingById: Map<string, CanvasNode>;
    preferred: CanvasNode | undefined;
    kind: CanvasNode["type"];
    name: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
}): CanvasNode {
    const { nextById, existingById, preferred, kind, name, position, data } = options;
    const id = preferred?.id ?? canvasNodeId(kind, name);
    const existing = preferred ?? existingById.get(id);
    const node = {
        id: id,
        type: kind,
        position: existing?.position ?? position,
        data: {
            ...(isRecord(existing?.data) ? existing.data : {}),
            ...data,
        },
    };
    nextById.set(id, node);

    return node;
}

function normalizeCanvasNode(node: CanvasNode): CanvasNode {
    return {
        id: String(node.id),
        type: node.type,
        position: node.position ?? { x: 0, y: 0 },
        data: isRecord(node.data) ? node.data : {},
    };
}

function normalizeCanvasEdge(edge: CanvasEdge): CanvasEdge {
    return {
        id: String(edge.id),
        source: String(edge.source),
        target: String(edge.target),
        animated: edge.animated,
    };
}

function canvasNodeId(kind: string, name: string): string {
    return `cli-${kind}-${name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "resource"}`;
}

/**
 * Default agent→service edge (agent→sandbox, agent→workspace): top/bottom handles,
 * rendered by the dashboard's DeletableEdge. `animated: true` gives the flowing
 * dashed look the dashboard uses for these connections.
 */
function addDesiredDefaultEdge(edges: Map<string, CanvasEdge>, source: string, target: string): void {
    const id = `xy-edge__${source}-${target}`;
    edges.set(id, { id: id, source: source, target: target, animated: true });
}

/**
 * Side-handle "mount" edge for a workspace↔sandbox relationship, matching the
 * dashboard's id scheme so it renders as the dotted MountEdge. The handles are
 * encoded in the id because the persisted edge keeps only id/source/target.
 */
function addDesiredMountEdge(
    edges: Map<string, CanvasEdge>,
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string,
): void {
    const id = `mount:${source}-${sourceHandle}-${target}-${targetHandle}`;
    edges.set(id, { id: id, source: source, target: target, animated: false });
}

/**
 * Side-handle "subagent" edge for an agent→agent call relationship. Matches the
 * dashboard's id scheme so it hydrates into the violet SubagentEdge; as with mount
 * edges only id/source/target are persisted and the handles/type are rebuilt from
 * the `subagent:` prefix on load. Source/target are the caller/callee agent nodes.
 */
function addDesiredSubagentEdge(edges: Map<string, CanvasEdge>, source: string, target: string): void {
    const id = `subagent:${source}-right-${target}-left`;
    edges.set(id, { id: id, source: source, target: target, animated: false });
}

function skillNodeIdForReference(nodeIdByKindName: Map<string, string>, value: string): string | undefined {
    const direct = nodeIdByKindName.get(`skill:${resourceName(value)}`);
    if (direct) return direct;

    const slashIndex = value.lastIndexOf("/");
    if (slashIndex < 0) return undefined;
    const localName = value.slice(slashIndex + 1);

    return localName.trim() ? nodeIdByKindName.get(`skill:${resourceName(localName)}`) : undefined;
}

function edgeIsCliManaged(edge: CanvasEdge, nodesById: Map<string, CanvasNode>): boolean {
    if (
        edge.id.startsWith("xy-edge__cli-") ||
        edge.id.startsWith("mount:cli-") ||
        edge.id.startsWith("subagent:cli-")
    ) {
        return true;
    }
    const sourceManagedBy = nodesById.get(edge.source)?.data.managedBy;
    const targetManagedBy = nodesById.get(edge.target)?.data.managedBy;

    return sourceManagedBy === "cli" && targetManagedBy === "cli";
}

function cliResourceKeyForNode(node: CanvasNode): string {
    const name = typeof node.data.label === "string" && node.data.label.trim()
        ? node.data.label.trim()
        : node.id.replace(/^cli-[^-]+-/, "");

    return `${node.type}:${name}`;
}

async function pruneAgents(
    ctx: MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
    resources: CliResource[],
): Promise<void> {
    const declared = new Set(
        resources.filter((entry) => entry.kind === "agent").map((entry) => resourceName(entry.name)),
    );
    const existing = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const config of existing) {
        if (config.managedBy !== "cli" || declared.has(config.name)) continue;
        if (config.agentId) {
            const agentId = ctx.db.normalizeId("agents", config.agentId);
            if (agentId) {
                const agent = await ctx.db.get(agentId);
                if (agent) await ctx.db.delete(agentId);
            }
        }
        await ctx.db.delete(config._id);
    }
}

async function pruneWorkspaceResources(
    ctx: MutationCtx,
    environmentId: Id<"environments">,
    resources: CliResource[],
): Promise<void> {
    const declared = new Set(
        resources.filter((entry) => entry.kind === "workspace").map((entry) => resourceName(entry.name)),
    );
    // Scope to this environment so prune never reaches across environments or
    // touches account-scoped (env-less) legacy / dashboard-shared rows.
    const existing = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    for (const workspace of existing) {
        if (workspace.managedBy === "cli" && !declared.has(workspace.name)) await ctx.db.delete(workspace._id);
    }
}

async function pruneSandboxResources(
    ctx: MutationCtx,
    environmentId: Id<"environments">,
    resources: CliResource[],
): Promise<void> {
    const declared = new Set(
        resources.filter((entry) => entry.kind === "sandbox").map((entry) => resourceName(entry.name)),
    );
    const existing = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    for (const sandbox of existing) {
        if (sandbox.managedBy === "cli" && !declared.has(sandbox.name)) await ctx.db.delete(sandbox._id);
    }
}

async function deleteAgentResource(
    ctx: MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
    name: string,
): Promise<void> {
    const configs = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const config = configs.find((entry) => entry.name === name);
    if (!config) return;
    if (config.managedBy !== "cli") {
        throw new Error(`Agent "${name}" is dashboard-managed and cannot be deleted through the CLI.`);
    }
    if (config.agentId) {
        const agentId = ctx.db.normalizeId("agents", config.agentId);
        if (agentId) {
            const agent = await ctx.db.get(agentId);
            if (agent) await ctx.db.delete(agentId);
        }
    }
    await ctx.db.delete(config._id);
}

async function deleteWorkspaceResource(
    ctx: MutationCtx,
    environmentId: Id<"environments">,
    name: string,
): Promise<void> {
    const workspace = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_environmentId_and_name", (q) =>
            q.eq("environmentId", environmentId).eq("name", name),
        )
        .unique();
    if (!workspace) return;
    if (workspace.managedBy !== "cli") {
        throw new Error(`Workspace "${name}" is dashboard-managed and cannot be deleted through the CLI.`);
    }
    await ctx.db.delete(workspace._id);
}

async function deleteSandboxResource(
    ctx: MutationCtx,
    environmentId: Id<"environments">,
    name: string,
): Promise<void> {
    const sandbox = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) =>
            q.eq("environmentId", environmentId).eq("name", name),
        )
        .unique();
    if (!sandbox) return;
    if (sandbox.managedBy !== "cli") {
        throw new Error(`Sandbox "${name}" is dashboard-managed and cannot be deleted through the CLI.`);
    }
    await ctx.db.delete(sandbox._id);
}

async function resourcesForEnvironment(
    ctx: QueryCtx | MutationCtx,
    accountId: Id<"accounts">,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): Promise<CliResource[]> {
    const sandboxes = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const workspaces = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const agents = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const agentIds = agents.flatMap((entry) => entry.agentId ? [entry.agentId] : []);
    const crons = (await Promise.all(
        agentIds.map((agentId) =>
            ctx.db
                .query("crons")
                .withIndex("by_accountId_and_agentId", (q) =>
                    q.eq("accountId", accountId).eq("agentId", agentId as Id<"agents">),
                )
                .collect(),
        ),
    )).flat();
    const sandboxNames = Object.fromEntries(sandboxes.map((entry) => [entry._id, entry.name]));
    const workspaceNames = Object.fromEntries(workspaces.map((entry) => [entry._id, entry.name]));
    const agentNames = Object.fromEntries(agents.flatMap((entry) =>
        entry.agentId ? [[entry.agentId, entry.name]] : [],
    ));
    const externalResources = await ctx.db
        .query("cliExternalResources")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const skillNames = Object.fromEntries(externalResources
        .filter((entry) => entry.kind === "skill")
        .map((entry) => [entry.externalId, entry.name]));
    const toolNames = Object.fromEntries(externalResources
        .filter((entry) => entry.kind === "tool")
        .map((entry) => [entry.externalId, entry.name]));

    // sandboxConfigs is stored encrypted (filthy-panty contract); decrypt back
    // into the manifest shape the CLI expects.
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    const sandboxResources: CliResource[] = await Promise.all(
        sandboxes.filter((sandbox) => sandbox.managedBy === "cli").map(async (sandbox): Promise<CliResource> => ({
            kind: "sandbox",
            name: sandbox.name,
            description: sandbox.description,
            config: await decryptSandboxManifestConfig(sandbox, secret),
        })),
    );

    return [
        ...agents.filter((agent) => agent.managedBy === "cli").map((agent): CliResource => ({
            kind: "agent",
            name: agent.name,
            description: agent.description,
            config: rewriteIdsToNames(toNestedAgentConfig({
                name: agent.name,
                description: agent.description,
                provider: agent.provider,
                modelId: agent.modelId,
                systemPrompt: agent.systemPrompt,
                maxTurns: agent.maxTurns,
                outputFormat: agent.outputFormat as Record<string, unknown> | undefined,
                providerOptions: agent.providerOptions as Record<string, unknown> | undefined,
                temperature: agent.temperature,
                maxTokens: agent.maxTokens,
                memoryToolEnabled: agent.memoryToolEnabled,
                searchToolEnabled: agent.searchToolEnabled,
                searchToolConfig: agent.searchToolConfig as Record<string, unknown> | undefined,
                extraConfig: agent.extraConfig as Record<string, unknown> | undefined,
            }), workspaceNames, sandboxNames, agentNames, skillNames, toolNames),
        })),
        ...externalResources.map((resource): CliResource => ({
            kind: resource.kind,
            name: resource.name,
            description: resource.description,
            config: resource.config,
        })),
        ...sandboxResources,
        ...workspaces.filter((workspace) => workspace.managedBy === "cli").map((workspace): CliResource => ({
            kind: "workspace",
            name: workspace.name,
            description: workspace.description,
            config: workspace.config,
        })),
        ...crons.flatMap((cron): CliResource[] => {
            const agentName = agentNames[cron.agentId];
            if (!agentName) return [];

            return [{
                kind: "cron",
                name: cron.name,
                description: cron.description,
                config: {
                    name: cron.name,
                    agentId: agentName,
                    events: cron.events,
                    scheduleExpression: cron.scheduleExpression,
                    ...(cron.conversationKey ? { conversationKey: cron.conversationKey } : {}),
                    ...(cron.timezone ? { timezone: cron.timezone } : {}),
                    status: cron.status,
                },
            }];
        }),
    ].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

async function idsForEnvironment(
    ctx: QueryCtx | MutationCtx,
    accountId: Id<"accounts">,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): Promise<Ids> {
    const sandboxes = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const workspaces = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const agents = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const agentIds = new Set(agents.flatMap((entry) => entry.agentId ? [entry.agentId] : []));
    const crons = (await Promise.all(
        [...agentIds].map((agentId) =>
            ctx.db
                .query("crons")
                .withIndex("by_accountId_and_agentId", (q) =>
                    q.eq("accountId", accountId).eq("agentId", agentId as Id<"agents">),
                )
                .collect(),
        ),
    )).flat();
    const externalIds = await externalIdsForEnvironment(ctx, projectId, environmentId);

    return {
        agents: Object.fromEntries(agents.filter((entry) => entry.managedBy === "cli").flatMap((entry) => entry.agentId ? [[entry.name, entry.agentId]] : [])),
        workspaces: Object.fromEntries(workspaces.filter((entry) => entry.managedBy === "cli").map((entry) => [entry.name, entry._id])),
        sandboxes: Object.fromEntries(sandboxes.filter((entry) => entry.managedBy === "cli").map((entry) => [entry.name, entry._id])),
        crons: Object.fromEntries(crons.flatMap((entry) =>
            agentIds.has(entry.agentId) ? [[entry.name, entry._id]] : [],
        )),
        skills: externalIds.skills,
        tools: externalIds.tools,
    };
}

async function externalIdsForEnvironment(
    ctx: QueryCtx | MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): Promise<{ skills: Record<string, string>; tools: Record<string, string> }> {
    const resources = await ctx.db
        .query("cliExternalResources")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();

    return {
        skills: Object.fromEntries(resources
            .filter((entry) => entry.kind === "skill")
            .map((entry) => [entry.name, entry.externalId])),
        tools: Object.fromEntries(resources
            .filter((entry) => entry.kind === "tool")
            .map((entry) => [entry.name, entry.externalId])),
    };
}


async function decryptSandboxConfig(
    sandbox: Doc<"sandboxConfigs">,
    secret: string | undefined,
): Promise<Record<string, unknown>> {
    if (!secret || !sandbox.encryptedConfig || !sandbox.encryptionIv || !sandbox.encryptionTag) {
        return {};
    }
    const decrypted = await decryptAgentConfigBlob(
        {
            ciphertext: sandbox.encryptedConfig,
            iv: sandbox.encryptionIv,
            tag: sandbox.encryptionTag,
        },
        secret,
    );

    return decrypted ?? {};
}

async function decryptSandboxManifestConfig(
    sandbox: Doc<"sandboxConfigs">,
    secret: string | undefined,
): Promise<Record<string, unknown>> {
    if (
        secret &&
        sandbox.encryptedSourceConfig &&
        sandbox.sourceEncryptionIv &&
        sandbox.sourceEncryptionTag
    ) {
        const decrypted = await decryptAgentConfigBlob(
            {
                ciphertext: sandbox.encryptedSourceConfig,
                iv: sandbox.sourceEncryptionIv,
                tag: sandbox.sourceEncryptionTag,
            },
            secret,
        );

        return decrypted ?? {};
    }

    return await decryptSandboxConfig(sandbox, secret);
}

function renameComparableAgent(agent: Doc<"agentConfigs">): unknown {
    return renameComparableResource(
        agent.description,
        toNestedAgentConfig({
            name: agent.name,
            description: agent.description,
            provider: agent.provider,
            modelId: agent.modelId,
            systemPrompt: agent.systemPrompt,
            maxTurns: agent.maxTurns,
            outputFormat: agent.outputFormat as Record<string, unknown> | undefined,
            providerOptions: agent.providerOptions as Record<string, unknown> | undefined,
            temperature: agent.temperature,
            maxTokens: agent.maxTokens,
            memoryToolEnabled: agent.memoryToolEnabled,
            searchToolEnabled: agent.searchToolEnabled,
            searchToolConfig: agent.searchToolConfig as Record<string, unknown> | undefined,
            extraConfig: agent.extraConfig as Record<string, unknown> | undefined,
        }),
    );
}

function renameComparableResource(description: string | undefined, config: unknown): unknown {
    return {
        description: description,
        config: config,
    };
}

function stableJson(value: unknown): string {
    return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortValue);
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, entry]) => [key, sortValue(entry)]),
        );
    }

    return value;
}

async function authIdForAccount(
    ctx: MutationCtx,
    account: Doc<"accounts">,
): Promise<string | null> {
    const orgId = ctx.db.normalizeId("orgs", account.orgId);
    if (!orgId) return null;
    const org = await ctx.db.get(orgId);

    return org?.ownerAuthId ?? null;
}

function rewriteEnvRefs(value: unknown, envNames: Set<string>): Record<string, unknown> {
    return rewriteEnvRefsValue(value, envNames) as Record<string, unknown>;
}

function rewriteEnvRefsValue(value: unknown, envNames: Set<string>): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => rewriteEnvRefsValue(entry, envNames));
    }
    if (isRecord(value)) {
        if (value.__beeblastEnv === true && typeof value.name === "string") {
            const name = envName(value.name);
            envNames.add(name);

            return `\${${name}}`;
        }

        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, rewriteEnvRefsValue(entry, envNames)]),
        );
    }

    return value;
}

function rewriteResourceRefs(
    config: Record<string, unknown>,
    workspaceIds: Record<string, string>,
    sandboxIds: Record<string, string>,
): Record<string, unknown> {
    const result = { ...config };
    if (typeof result.sandbox === "string" && sandboxIds[result.sandbox]) {
        result.sandbox = sandboxIds[result.sandbox];
    }
    if (Array.isArray(result.workspaces)) {
        result.workspaces = result.workspaces.map((entry) => {
            if (!isRecord(entry)) return entry;
            const workspaceId = typeof entry.workspaceId === "string" && workspaceIds[entry.workspaceId]
                ? workspaceIds[entry.workspaceId]
                : entry.workspaceId;
            const sandbox = typeof entry.sandbox === "string" && sandboxIds[entry.sandbox]
                ? sandboxIds[entry.sandbox]
                : entry.sandbox;

            return {
                ...entry,
                workspaceId: workspaceId,
                ...(entry.sandbox !== undefined ? { sandbox: sandbox } : {}),
            };
        });
    }

    return result;
}

function rewriteIdsToNames(
    config: Record<string, unknown>,
    workspaceNames: Record<string, string>,
    sandboxNames: Record<string, string>,
    agentNames: Record<string, string> = {},
    skillNames: Record<string, string> = {},
    toolNames: Record<string, string> = {},
): Record<string, unknown> {
    const result = { ...config };
    if (typeof result.sandbox === "string" && sandboxNames[result.sandbox]) {
        result.sandbox = sandboxNames[result.sandbox];
    }
    if (Array.isArray(result.workspaces)) {
        result.workspaces = result.workspaces.map((entry) => {
            if (!isRecord(entry)) return entry;
            const workspaceId = typeof entry.workspaceId === "string" && workspaceNames[entry.workspaceId]
                ? workspaceNames[entry.workspaceId]
                : entry.workspaceId;
            const sandbox = typeof entry.sandbox === "string" && sandboxNames[entry.sandbox]
                ? sandboxNames[entry.sandbox]
                : entry.sandbox;

            return {
                ...entry,
                workspaceId: workspaceId,
                ...(entry.sandbox !== undefined ? { sandbox: sandbox } : {}),
            };
        });
    }
    if (isRecord(result.subagent) && Array.isArray(result.subagent.allowed)) {
        result.subagent = {
            ...result.subagent,
            allowed: result.subagent.allowed.map((entry) =>
                typeof entry === "string" && agentNames[entry] ? agentNames[entry] : entry,
            ),
        };
    }
    if (isRecord(result.skills) && Array.isArray(result.skills.allowed)) {
        result.skills = {
            ...result.skills,
            allowed: result.skills.allowed.map((entry) =>
                typeof entry === "string" && skillNames[entry] ? skillNames[entry] : entry,
            ),
        };
    }
    if (isRecord(result.tools)) {
        result.tools = Object.fromEntries(Object.entries(result.tools).map(([key, value]) => [
            toolNames[key] ?? key,
            value,
        ]));
    }

    return result;
}

function snapshotExternalConfig(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(snapshotExternalConfig);
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
            if (key === "contentBase64" || key === "bundle") return [];
            if (key === "files" && Array.isArray(entry)) {
                return [[key, entry.map((file) => {
                    if (!isRecord(file)) return snapshotExternalConfig(file);
                    const { contentBase64: _contentBase64, ...rest } = file;
                    return snapshotExternalConfig(rest);
                })]];
            }

            return [[key, snapshotExternalConfig(entry)]];
        }));
    }

    return value;
}

function asObject(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error("Resource config must be an object");

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resourceName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Resource name is required");

    return trimmed;
}

function environmentNameEquals(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function environmentKindForName(name: string): "development" | "production" | "custom" {
    const normalized = name.trim().toLowerCase();
    if (normalized === "development") return "development";
    if (normalized === "production") return "production";

    return "custom";
}

function displayEnvironmentName(name: string): string {
    const kind = environmentKindForName(name);
    if (kind === "development") return "Development";
    if (kind === "production") return "Production";

    return name;
}

function envName(value: string): string {
    const trimmed = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        throw new Error(`Invalid environment variable name: ${value}`);
    }

    return trimmed;
}
