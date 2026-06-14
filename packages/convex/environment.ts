/**
 * Public environment queries and mutations scoped to a project owner.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { ensureAgentsRowForConfig, pushEncryptedConfigToAgentRow } from "./model/agentSync";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject, getProjectForRole } from "./model/ownership/project";
import { environmentsFields } from "./schema";

const deploymentRegion = v.union(v.literal("ap-southeast-1"), v.literal("eu-central-1"), v.literal("us-east-1"));

const environmentDoc = v.object({
    ...environmentsFields,
    _id: v.id("environments"),
    _creationTime: v.number(),
});

type EnvironmentKind = "development" | "production" | "custom";

/** Infer semantic environment role for legacy rows that predate `kind`. */
export function environmentKindForName(environment: Pick<Doc<"environments">, "name" | "kind">): EnvironmentKind {
    if (environment.kind) return environment.kind;
    const normalized = environment.name.trim().toLowerCase();
    if (normalized === "development") return "development";
    if (normalized === "production") return "production";

    return "custom";
}

/** Case-insensitive lookup by explicit kind or conventional environment name. */
function findEnvironmentByKind(
    environments: Doc<"environments">[],
    kind: EnvironmentKind,
): Doc<"environments"> | undefined {
    return environments.find((environment) => environmentKindForName(environment) === kind);
}

/** Strip Convex system fields so a fetched doc can be re-inserted as a clone. */
function stripSystemFields<T extends object>(doc: T): Omit<T, "_id" | "_creationTime"> {
    const clone = { ...(doc as Record<string, unknown>) };
    delete clone._id;
    delete clone._creationTime;

    return clone as Omit<T, "_id" | "_creationTime">;
}

/** Coerce an unknown JSON-ish value into a mutable record. */
function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * Deep-copies every resource scoped to `sourceEnvironmentId` into `targetEnvironmentId`:
 * agent configs (each with a fresh filthy-panty `agents` row), the canvas layout
 * (remapping node references to the cloned configs), tool services, and env vars.
 * Subagent allow-lists are remapped onto the cloned agents so agent→agent calls stay
 * within the new environment.
 */
async function duplicateEnvironmentContents(
    ctx: MutationCtx,
    authId: string,
    projectId: Id<"projects">,
    sourceEnvironmentId: Id<"environments">,
    targetEnvironmentId: Id<"environments">,
    now: number,
): Promise<void> {
    // 1. Clone agent configs and provision their agents rows, tracking id remaps.
    const sourceConfigs = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", sourceEnvironmentId),
        )
        .collect();

    const configIdMap = new Map<Id<"agentConfigs">, Id<"agentConfigs">>();
    const agentIdMap = new Map<string, string>();
    for (const source of sourceConfigs) {
        const newConfigId = await ctx.db.insert("agentConfigs", {
            ...stripSystemFields(source),
            environmentId: targetEnvironmentId,
            agentId: undefined,
            updatedAt: now,
        });
        configIdMap.set(source._id, newConfigId);

        const newAgentId = await ensureAgentsRowForConfig(ctx, newConfigId, authId);
        if (source.agentId && newAgentId) agentIdMap.set(source.agentId, newAgentId);
    }

    // 2. Remap each clone's subagent allow-list onto the new agents, then push config.
    for (const newConfigId of configIdMap.values()) {
        const clone = await ctx.db.get(newConfigId);
        if (!clone) continue;

        const extraConfig = asRecord(clone.extraConfig);
        const subagent = asRecord(extraConfig.subagent);
        if (Array.isArray(subagent.allowed)) {
            const remapped = (subagent.allowed as string[])
                .map((agentId) => agentIdMap.get(agentId))
                .filter((agentId): agentId is string => !!agentId);
            const nextExtra = { ...extraConfig };
            if (remapped.length > 0) {
                nextExtra.subagent = { ...subagent, allowed: remapped, enabled: true };
            } else {
                delete nextExtra.subagent;
            }
            await ctx.db.patch(newConfigId, { extraConfig: nextExtra, updatedAt: now });
        }

        await pushEncryptedConfigToAgentRow(ctx, newConfigId);
    }

    // 3. Clone the canvas layout, repointing agent nodes at the cloned configs.
    const sourceLayout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", sourceEnvironmentId),
        )
        .unique();
    if (sourceLayout) {
        const remappedNodes = (sourceLayout.nodes as Array<Record<string, unknown>>).map((node) => {
            const data = asRecord(node.data);
            const oldConfigId = data.agentConfigId as Id<"agentConfigs"> | undefined;
            const newConfigId = oldConfigId ? configIdMap.get(oldConfigId) : undefined;

            return newConfigId ? { ...node, data: { ...data, agentConfigId: newConfigId } } : node;
        });
        await ctx.db.insert("canvasLayouts", {
            authId: authId,
            projectId: projectId,
            environmentId: targetEnvironmentId,
            nodes: remappedNodes,
            edges: sourceLayout.edges,
            updatedAt: now,
        });
    }

    // 4. Clone tool services.
    const sourceTools = await ctx.db
        .query("toolServices")
        .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", sourceEnvironmentId),
        )
        .collect();
    for (const tool of sourceTools) {
        await ctx.db.insert("toolServices", {
            ...stripSystemFields(tool),
            environmentId: targetEnvironmentId,
            updatedAt: now,
        });
    }

    // 5. Clone environment variables.
    const sourceVars = await ctx.db
        .query("environmentVariables")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", sourceEnvironmentId),
        )
        .collect();
    for (const variable of sourceVars) {
        await ctx.db.insert("environmentVariables", {
            ...stripSystemFields(variable),
            environmentId: targetEnvironmentId,
            updatedAt: now,
        });
    }

    // 6. Clone webhooks (each gets a fresh signing secret rather than copying it).
    const sourceWebhooks = await ctx.db
        .query("webhooks")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", sourceEnvironmentId),
        )
        .collect();
    for (const webhook of sourceWebhooks) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        await ctx.db.insert("webhooks", {
            ...stripSystemFields(webhook),
            environmentId: targetEnvironmentId,
            secret: `whsec_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
            createdAt: now,
            updatedAt: now,
        });
    }
}

/**
 * Cascade-deletes every resource scoped to an environment: agent configs (plus their
 * deployments and linked filthy-panty `agents` rows), the canvas layout, tool
 * services, env vars, and deploy keys.
 */
export async function deleteEnvironmentContents(
    ctx: MutationCtx,
    environment: Doc<"environments">,
): Promise<void> {
    const { projectId, _id: environmentId } = environment;

    const configs = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const config of configs) {
        if (config.agentId) {
            const normalized = ctx.db.normalizeId("agents", config.agentId);
            if (normalized) {
                const agent = await ctx.db.get(normalized);
                if (agent) await ctx.db.delete(normalized);
            }
        }

        await ctx.db.delete(config._id);
    }

    // The environment's runtime API key is scoped to (project, environment), not
    // to an agent config, so it must be deleted here or it would keep
    // authenticating requests against a deleted environment.
    const envDeployments = await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const deployment of envDeployments) await ctx.db.delete(deployment._id);

    const layouts = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const layout of layouts) await ctx.db.delete(layout._id);

    const tools = await ctx.db
        .query("toolServices")
        .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const tool of tools) await ctx.db.delete(tool._id);

    const variables = await ctx.db
        .query("environmentVariables")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const variable of variables) await ctx.db.delete(variable._id);

    const deployKeys = await ctx.db
        .query("deployKeys")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const deployKey of deployKeys) await ctx.db.delete(deployKey._id);

    const webhooks = await ctx.db
        .query("webhooks")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .collect();
    for (const webhook of webhooks) await ctx.db.delete(webhook._id);
}

/** Returns true when an environment already has user/configuration content. */
async function hasEnvironmentContents(
    ctx: MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): Promise<boolean> {
    const agentConfig = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .first();
    if (agentConfig) return true;

    const layout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .first();
    if (layout) return true;

    const tool = await ctx.db
        .query("toolServices")
        .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .first();
    if (tool) return true;

    const variable = await ctx.db
        .query("environmentVariables")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .first();
    if (variable) return true;

    const webhook = await ctx.db
        .query("webhooks")
        .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
        )
        .first();

    return Boolean(webhook);
}

export const list = query({
    args: { projectId: v.id("projects") },
    returns: v.array(environmentDoc),
    handler: async (ctx, { projectId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        // Return empty rather than throwing so a just-deleted project doesn't crash
        // reactive subscribers (header selector, settings) before they navigate away.
        const project = await getProjectForRole(ctx, authUser.id, projectId, "admin");
        if (!project) return [];

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        return environments.sort((a, b) =>
            a.isDefault !== b.isDefault
                ? (a.isDefault ? -1 : 1)
                : a.name.localeCompare(b.name),
        );
    },
});

export const ensureDefault = mutation({
    args: { projectId: v.id("projects") },
    returns: v.union(v.null(), v.id("environments")),
    handler: async (ctx, { projectId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        // No-op when the project is gone: a just-deleted project briefly keeps the
        // header's "no environments → ensureDefault" effect firing, so return null
        // instead of throwing rather than resurrecting an environment.
        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) return null;

        const existing = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        const now = Date.now();
        const development = findEnvironmentByKind(existing, "development");

        // Legacy rows predating `kind` named "Production" were really the dev
        // workspace, so promote a lone one to Development. A row with an explicit
        // `kind` is an intentional choice and must never be renamed.
        const legacyProductionToPromote =
            !development &&
            existing.length === 1 &&
            existing[0]?.kind === undefined &&
            environmentKindForName(existing[0]) === "production"
                ? existing[0]
                : undefined;
        if (legacyProductionToPromote) {
            await ctx.db.patch(legacyProductionToPromote._id, {
                name: "Development",
                kind: "development",
                deploymentRegion: undefined,
                isDefault: true,
                updatedAt: now,
            });
            await ctx.db.patch(projectId, { updatedAt: now });

            return legacyProductionToPromote._id;
        }

        // Otherwise guarantee a Development row that is the sole default, creating
        // one if needed and demoting any other environment that claims the default.
        let changed = !development;
        const developmentId =
            development?._id ??
            (await ctx.db.insert("environments", {
                authId: authUser.id,
                projectId,
                name: "Development",
                kind: "development",
                isDefault: true,
                updatedAt: now,
            }));

        for (const environment of existing) {
            const shouldBeDefault = environment._id === developmentId;
            const needsNameFix = shouldBeDefault && (environment.kind !== "development" || environment.name !== "Development");
            if (environment.isDefault !== shouldBeDefault || needsNameFix) {
                await ctx.db.patch(environment._id, {
                    ...(shouldBeDefault ? { name: "Development", kind: "development" as const } : {}),
                    isDefault: shouldBeDefault,
                    updatedAt: now,
                });
                changed = true;
            }
        }
        if (changed) await ctx.db.patch(projectId, { updatedAt: now });

        return developmentId;
    },
});

export const create = mutation({
    args: {
        projectId: v.id("projects"),
        name: v.string(),
        duplicateFromId: v.optional(v.id("environments")),
    },
    returns: v.id("environments"),
    handler: async (ctx, { projectId, name, duplicateFromId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        if (duplicateFromId) {
            const source = await getOwnedEnvironment(ctx, authUser.id, duplicateFromId);
            if (!source || source.projectId !== projectId) {
                throw new Error("Source environment not found.");
            }
        }

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Environment name is required.");

        const now = Date.now();
        const environmentId = await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: trimmedName,
            kind: "custom",
            isDefault: false,
            updatedAt: now,
        });

        // Deep-copy the source environment's full architecture into the new one.
        if (duplicateFromId) {
            await duplicateEnvironmentContents(
                ctx,
                authUser.id,
                projectId,
                duplicateFromId,
                environmentId,
                now,
            );
        }

        await ctx.db.patch(projectId, { updatedAt: now });
        return environmentId;
    },
});

export const initializeProduction = mutation({
    args: {
        projectId: v.id("projects"),
        sourceEnvironmentId: v.id("environments"),
        deploymentRegion: deploymentRegion,
    },
    returns: v.id("environments"),
    handler: async (ctx, { projectId, sourceEnvironmentId, deploymentRegion }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const source = await getOwnedEnvironment(ctx, authUser.id, sourceEnvironmentId);
        if (!source || source.projectId !== projectId) {
            throw new Error("Source environment not found.");
        }

        const existing = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();
        const production = findEnvironmentByKind(existing, "production");
        const now = Date.now();
        const productionId = production?._id ?? await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId: projectId,
            name: "Production",
            kind: "production",
            deploymentRegion: deploymentRegion,
            isDefault: false,
            updatedAt: now,
        });

        const productionHasContents = production
            ? await hasEnvironmentContents(ctx, projectId, production._id)
            : false;
        if (!productionHasContents && productionId !== sourceEnvironmentId) {
            await duplicateEnvironmentContents(
                ctx,
                authUser.id,
                projectId,
                sourceEnvironmentId,
                productionId,
                now,
            );
        }

        await ctx.db.patch(productionId, {
            name: "Production",
            kind: "production",
            deploymentRegion: deploymentRegion,
            isDefault: false,
            updatedAt: now,
        });
        for (const environment of existing.filter((entry) => entry._id !== productionId && entry.isDefault && environmentKindForName(entry) !== "development")) {
            await ctx.db.patch(environment._id, { isDefault: false, updatedAt: now });
        }
        await ctx.db.patch(projectId, { updatedAt: now });

        return productionId;
    },
});

export const remove = mutation({
    args: { environmentId: v.id("environments") },
    returns: v.id("environments"),
    handler: async (ctx, { environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment) throw new Error("Environment not found.");
        if (environment.isDefault) throw new Error("The default environment cannot be deleted.");
        const project = await getProjectForRole(ctx, authUser.id, environment.projectId, "admin");
        if (!project) throw new Error("Environment not found.");

        // Cascade-delete every resource scoped to this environment before the row itself.
        await deleteEnvironmentContents(ctx, environment);

        await ctx.db.delete(environmentId);
        await ctx.db.patch(environment.projectId, { updatedAt: Date.now() });
        return environmentId;
    },
});
