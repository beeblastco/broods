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

const environmentDoc = v.object({
    ...environmentsFields,
    _id: v.id("environments"),
    _creationTime: v.number(),
});

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
        const deployments = await ctx.db
            .query("agentDeployments")
            .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
            .collect();
        for (const deployment of deployments) await ctx.db.delete(deployment._id);

        if (config.agentId) {
            const normalized = ctx.db.normalizeId("agents", config.agentId);
            if (normalized) {
                const agent = await ctx.db.get(normalized);
                if (agent) await ctx.db.delete(normalized);
            }
        }

        await ctx.db.delete(config._id);
    }

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

        const existingDefault = existing.find((e) => e.isDefault);
        if (existingDefault) return existingDefault._id;

        const now = Date.now();
        const environmentId = await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        await ctx.db.patch(projectId, { updatedAt: now });
        return environmentId;
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
