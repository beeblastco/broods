/**
 * CLI manifest sync for code-defined BeeBlast resources.
 *
 * Authenticates with the org Bearer secret and writes desired-state resources
 * into the SaaS project/environment model before syncing runtime agent rows.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ensureAgentsRowForConfig, pushEncryptedConfigToAgentRow, syncAgentRowFields } from "./model/agentSync";
import {
    decryptAgentConfigBlob,
    encryptAgentConfigBlob,
    fromNestedAgentConfig,
    toNestedAgentConfig,
} from "./model/agentConfigCodec";
import { uniqueProjectSlug } from "./lib/slug";

const resourceValidator = v.object({
    kind: v.union(
        v.literal("agent"),
        v.literal("workspace"),
        v.literal("sandbox"),
        v.literal("cronJob"),
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
    cronJobs: v.record(v.string(), v.string()),
});

type CliResource = {
    kind: "agent" | "workspace" | "sandbox" | "cronJob";
    name: string;
    description?: string;
    config: unknown;
};

type Ids = {
    agents: Record<string, string>;
    workspaces: Record<string, string>;
    sandboxes: Record<string, string>;
    cronJobs: Record<string, string>;
};

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

export const syncManifestBySecretHash = internalMutation({
    args: {
        secretHash: v.string(),
        manifest: manifestValidator,
        prune: v.optional(v.boolean()),
    },
    returns: v.object({ manifest: v.any(), ids: idsValidator }),
    handler: async (ctx, args) => {
        const { secretHash, manifest, prune } = args;
        const account = await accountFromSecretHash(ctx, secretHash);
        if (!account) throw new Error("Invalid BeeBlast token");

        const projectDoc = await ensureProject(ctx, account, manifest.project);
        const environmentDoc = await ensureEnvironment(ctx, projectDoc, manifest.environment);
        const workspaceIds = await syncWorkspaceResources(ctx, account._id, manifest.resources);
        const sandboxIds = await syncSandboxResources(ctx, account._id, manifest.resources);
        const envValues = await environmentVariables(ctx, projectDoc._id, environmentDoc._id);
        const agentIds = await syncAgentResources(ctx, {
            account: account,
            projectId: projectDoc._id,
            environmentId: environmentDoc._id,
            resources: manifest.resources,
            workspaceIds: workspaceIds,
            sandboxIds: sandboxIds,
            envValues: envValues,
        });

        if (prune === true) {
            await pruneAgents(ctx, projectDoc._id, environmentDoc._id, manifest.resources);
            await pruneWorkspaceResources(ctx, account._id, manifest.resources);
            await pruneSandboxResources(ctx, account._id, manifest.resources);
        }

        await ctx.db.patch(projectDoc._id, { updatedAt: Date.now() });
        const ids: Ids = {
            agents: agentIds,
            workspaces: workspaceIds,
            sandboxes: sandboxIds,
            cronJobs: {},
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
        };
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
            await deleteWorkspaceResource(ctx, account._id, normalizedName);
        } else {
            await deleteSandboxResource(ctx, account._id, normalizedName);
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

        if (existing) {
            await ctx.db.patch(existing._id, {
                value: value,
                updatedAt: Date.now(),
            });
        } else {
            await ctx.db.insert("environmentVariables", {
                projectId: projectDoc._id,
                environmentId: environmentDoc._id,
                name: normalizedName,
                value: value,
                updatedAt: Date.now(),
            });
        }

        return null;
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
    const environmentDoc = environments.find((entry) => entry.name === normalizedEnvironment);
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
    const existing = environments.find((entry) => entry.name === name);
    if (existing) return existing;

    const environmentId = await ctx.db.insert("environments", {
        authId: project.authId,
        projectId: project._id,
        name: name,
        isDefault: environments.length === 0,
        updatedAt: Date.now(),
    });
    const created = await ctx.db.get(environmentId);
    if (!created) throw new Error("Failed to create environment");

    return created;
}

async function syncWorkspaceResources(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
    resources: CliResource[],
): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const resource of resources.filter((entry) => entry.kind === "workspace")) {
        const name = resourceName(resource.name);
        const existing = await ctx.db
            .query("workspaceConfigs")
            .withIndex("by_accountId_and_name", (q) =>
                q.eq("accountId", accountId).eq("name", name),
            )
            .unique();
        if (existing) {
            await ctx.db.patch(existing._id, {
                description: resource.description,
                config: resource.config,
                updatedAt: Date.now(),
            });
            ids[name] = existing._id;
        } else {
            const now = Date.now();
            const id = await ctx.db.insert("workspaceConfigs", {
                accountId: accountId,
                name: name,
                description: resource.description,
                config: resource.config,
                createdAt: now,
                updatedAt: now,
            });
            ids[name] = id;
        }
    }

    return ids;
}

async function syncSandboxResources(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
    resources: CliResource[],
): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    const sandboxes = resources.filter((entry) => entry.kind === "sandbox");
    if (sandboxes.length === 0) return ids;

    // sandboxConfigs is a shared SaaS table owned by filthy-panty: the blob is
    // stored encrypted at rest (envVars/options may carry provider secrets).
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to sync sandbox configs");
    }

    for (const resource of sandboxes) {
        const name = resourceName(resource.name);
        const encrypted = await encryptAgentConfigBlob(asObject(resource.config), secret);
        const existing = await ctx.db
            .query("sandboxConfigs")
            .withIndex("by_accountId_and_name", (q) =>
                q.eq("accountId", accountId).eq("name", name),
            )
            .unique();
        if (existing) {
            await ctx.db.patch(existing._id, {
                description: resource.description,
                encryptedConfig: encrypted.ciphertext,
                encryptionIv: encrypted.iv,
                encryptionTag: encrypted.tag,
                updatedAt: Date.now(),
            });
            ids[name] = existing._id;
        } else {
            const now = Date.now();
            const id = await ctx.db.insert("sandboxConfigs", {
                accountId: accountId,
                name: name,
                description: resource.description,
                encryptedConfig: encrypted.ciphertext,
                encryptionIv: encrypted.iv,
                encryptionTag: encrypted.tag,
                createdAt: now,
                updatedAt: now,
            });
            ids[name] = id;
        }
    }

    return ids;
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
    },
): Promise<Record<string, string>> {
    const { account, projectId, environmentId, resources, workspaceIds, sandboxIds, envValues } = options;
    const ids: Record<string, string> = {};
    const existing = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();

    for (const resource of resources.filter((entry) => entry.kind === "agent")) {
        const name = resourceName(resource.name);
        const envNames = new Set<string>();
        const nested = rewriteResourceRefs(
            rewriteEnvRefs(asObject(resource.config), envNames),
            workspaceIds,
            sandboxIds,
        );
        const flat = fromNestedAgentConfig(nested);
        const runtimeVariables = [...envNames]
            .filter((envNameEntry) => envValues[envNameEntry] !== undefined)
            .map((envNameEntry) => ({ key: envNameEntry, value: envValues[envNameEntry] }));
        const current = existing.find((entry) => entry.name === name);
        if (current) {
            await ctx.db.patch(current._id, {
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
                runtimeVariables: runtimeVariables,
                extraConfig: flat.extraConfig,
                updatedAt: Date.now(),
            });
            await ensureAgentsRowForConfig(ctx, current._id, current.authId);
            await syncAgentRowFields(ctx, current._id, {
                name: name,
                description: resource.description,
            });
            await pushEncryptedConfigToAgentRow(ctx, current._id);
            const refreshed = await ctx.db.get(current._id);
            if (refreshed?.agentId) ids[name] = refreshed.agentId;
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
                runtimeVariables: runtimeVariables,
                extraConfig: flat.extraConfig,
                publicAccessEnabled: false,
                webSocketEnabled: false,
                updatedAt: Date.now(),
            });
            await ensureAgentsRowForConfig(ctx, configId, authId);
            await pushEncryptedConfigToAgentRow(ctx, configId);
            const created = await ctx.db.get(configId);
            if (created?.agentId) ids[name] = created.agentId;
        }
    }

    return ids;
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
        if (declared.has(config.name)) continue;
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
    accountId: Id<"accounts">,
    resources: CliResource[],
): Promise<void> {
    const declared = new Set(
        resources.filter((entry) => entry.kind === "workspace").map((entry) => resourceName(entry.name)),
    );
    const existing = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    for (const workspace of existing) {
        if (!declared.has(workspace.name)) await ctx.db.delete(workspace._id);
    }
}

async function pruneSandboxResources(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
    resources: CliResource[],
): Promise<void> {
    const declared = new Set(
        resources.filter((entry) => entry.kind === "sandbox").map((entry) => resourceName(entry.name)),
    );
    const existing = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    for (const sandbox of existing) {
        if (!declared.has(sandbox.name)) await ctx.db.delete(sandbox._id);
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
    accountId: Id<"accounts">,
    name: string,
): Promise<void> {
    const workspace = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_accountId_and_name", (q) =>
            q.eq("accountId", accountId).eq("name", name),
        )
        .unique();
    if (workspace) await ctx.db.delete(workspace._id);
}

async function deleteSandboxResource(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
    name: string,
): Promise<void> {
    const sandbox = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_accountId_and_name", (q) =>
            q.eq("accountId", accountId).eq("name", name),
        )
        .unique();
    if (sandbox) await ctx.db.delete(sandbox._id);
}

async function resourcesForEnvironment(
    ctx: QueryCtx | MutationCtx,
    accountId: Id<"accounts">,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): Promise<CliResource[]> {
    const sandboxes = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    const workspaces = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    const agents = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const cronJobs = await ctx.db
        .query("cronJobs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    const sandboxNames = Object.fromEntries(sandboxes.map((entry) => [entry._id, entry.name]));
    const workspaceNames = Object.fromEntries(workspaces.map((entry) => [entry._id, entry.name]));
    const agentNames = Object.fromEntries(agents.flatMap((entry) =>
        entry.agentId ? [[entry.agentId, entry.name]] : [],
    ));

    // sandboxConfigs is stored encrypted (filthy-panty contract); decrypt back
    // into the manifest shape the CLI expects.
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    const sandboxResources: CliResource[] = await Promise.all(
        sandboxes.map(async (sandbox): Promise<CliResource> => ({
            kind: "sandbox",
            name: sandbox.name,
            description: sandbox.description,
            config: await decryptSandboxConfig(sandbox, secret),
        })),
    );

    return [
        ...agents.map((agent): CliResource => ({
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
            }), workspaceNames, sandboxNames),
        })),
        ...sandboxResources,
        ...workspaces.map((workspace): CliResource => ({
            kind: "workspace",
            name: workspace.name,
            description: workspace.description,
            config: workspace.config,
        })),
        ...cronJobs.flatMap((cronJob): CliResource[] => {
            const agentName = agentNames[cronJob.agentId];
            if (!agentName) return [];

            return [{
                kind: "cronJob",
                name: cronJob.name,
                description: cronJob.description,
                config: {
                    name: cronJob.name,
                    agentId: agentName,
                    prompt: cronJob.prompt,
                    scheduleExpression: cronJob.scheduleExpression,
                    ...(cronJob.conversationKey ? { conversationKey: cronJob.conversationKey } : {}),
                    ...(cronJob.timezone ? { timezone: cronJob.timezone } : {}),
                    status: cronJob.status,
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
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    const workspaces = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();
    const agents = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    const agentIds = new Set(agents.flatMap((entry) => entry.agentId ? [entry.agentId] : []));
    const cronJobs = await ctx.db
        .query("cronJobs")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();

    return {
        agents: Object.fromEntries(agents.flatMap((entry) => entry.agentId ? [[entry.name, entry.agentId]] : [])),
        workspaces: Object.fromEntries(workspaces.map((entry) => [entry.name, entry._id])),
        sandboxes: Object.fromEntries(sandboxes.map((entry) => [entry.name, entry._id])),
        cronJobs: Object.fromEntries(cronJobs.flatMap((entry) =>
            agentIds.has(entry.agentId) ? [[entry.name, entry._id]] : [],
        )),
    };
}

async function environmentVariables(
    ctx: MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): Promise<Record<string, string>> {
    const rows = await ctx.db
        .query("environmentVariables")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();

    return Object.fromEntries(rows.map((row) => [row.name, row.value]));
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

    return result;
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

function envName(value: string): string {
    const trimmed = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        throw new Error(`Invalid environment variable name: ${value}`);
    }

    return trimmed;
}
