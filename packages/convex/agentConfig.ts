/**
 * Agent config CRUD for the canvas UI. Scoped to authenticated user.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureAgentsRowForConfig, syncAgentRowFields } from "./model/agentSync";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { agentConfigsFields } from "./schema";

const agentProviderValidator = v.union(
    v.literal("openai"),
    v.literal("google"),
    v.literal("bedrock"),
    v.literal("anthropic"),
);

const agentConfigDoc = v.object({
    ...agentConfigsFields,
    _id: v.id("agentConfigs"),
    _creationTime: v.number(),
});

export const getById = query({
    args: { configId: v.id("agentConfigs") },
    returns: v.union(v.null(), agentConfigDoc),
    handler: async (ctx, { configId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const config = await ctx.db.get(configId);
        return config && config.authId === authUser.id ? config : null;
    },
});

export const create = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        name: v.string(),
        provider: v.optional(agentProviderValidator),
        modelId: v.optional(v.string()),
        description: v.optional(v.string()),
        systemPrompt: v.optional(v.string()),
        position: v.optional(v.object({ x: v.number(), y: v.number() })),
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, args) => {
        const { projectId, environmentId, name, provider, modelId, description, systemPrompt, position } = args;

        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const now = Date.now();
        const trimmedName = name.trim();
        const configId = await ctx.db.insert("agentConfigs", {
            authId: authUser.id,
            name: trimmedName,
            description: description?.trim() || undefined,
            agentId: undefined,
            projectId,
            environmentId,
            provider,
            modelId: modelId?.trim() || "gpt-4.1-mini",
            systemPrompt: systemPrompt?.trim() || undefined,
            memoryToolEnabled: true,
            searchToolEnabled: false,
            publicAccessEnabled: false,
            webSocketEnabled: false,
            updatedAt: now,
        });

        await ctx.db.patch(projectId, { updatedAt: now });

        if (position) {
            const layout = await ctx.db
                .query("canvasLayouts")
                .withIndex("by_projectId_and_environmentId", (q) =>
                    q.eq("projectId", projectId).eq("environmentId", environmentId),
                )
                .unique();

            const nextNode = {
                id: String(now),
                type: "agent" as const,
                position,
                data: {
                    label: trimmedName,
                    status: "idle" as const,
                    agentConfigId: configId,
                },
            };

            if (layout) {
                await ctx.db.patch(layout._id, {
                    nodes: [...layout.nodes, nextNode],
                    updatedAt: now,
                });
            } else {
                await ctx.db.insert("canvasLayouts", {
                    authId: authUser.id,
                    projectId,
                    environmentId,
                    nodes: [nextNode],
                    edges: [],
                    updatedAt: now,
                });
            }
        }

        // Provision the filthy-panty agents row so the harness can resolve
        // this config by its public agentId. No-ops if the org isn't yet
        // provisioned with a filthy-panty account.
        await ensureAgentsRowForConfig(ctx, configId, authUser.id);

        return configId;
    },
});

export const update = mutation({
    args: {
        configId: v.id("agentConfigs"),
        name: v.optional(v.string()),
        provider: v.optional(agentProviderValidator),
        modelId: v.optional(v.string()),
        description: v.optional(v.string()),
        systemPrompt: v.optional(v.string()),
        maxTurns: v.optional(v.number()),
        allowedTools: v.optional(v.array(v.string())),
        permissionMode: v.optional(v.string()),
        outputFormat: v.optional(v.any()),
        providerOptions: v.optional(v.any()),
        temperature: v.optional(v.number()),
        maxTokens: v.optional(v.number()),
        publicAccessEnabled: v.optional(v.boolean()),
        webSocketEnabled: v.optional(v.boolean()),
        memoryToolEnabled: v.optional(v.boolean()),
        searchToolEnabled: v.optional(v.boolean()),
        searchToolConfig: v.optional(v.any()),
        runtimeVariables: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
        agentId: v.optional(v.string()),
        extraConfig: v.optional(v.any()),
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, { configId, ...updates }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const existing = await ctx.db.get(configId);
        if (!existing || existing.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        const patch = Object.fromEntries(
            Object.entries(updates).filter(([, v]) => v !== undefined),
        );

        await ctx.db.patch(configId, { ...patch, updatedAt: Date.now() });

        // Keep the filthy-panty `agents` row aligned. ensureAgentsRowForConfig
        // also covers the legacy case where the row was never provisioned
        // (e.g. agentConfigs created before this sync was wired).
        await ensureAgentsRowForConfig(ctx, configId, authUser.id);
        await syncAgentRowFields(ctx, configId, {
            name: updates.name,
            description: updates.description,
        });

        return configId;
    },
});

export const remove = mutation({
    args: { configId: v.id("agentConfigs") },
    returns: v.id("agentConfigs"),
    handler: async (ctx, { configId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const existing = await ctx.db.get(configId);
        if (!existing || existing.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        const deployments = await ctx.db
            .query("agentDeployments")
            .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
            .collect();

        for (const d of deployments) await ctx.db.delete(d._id);

        // Clean up the linked filthy-panty `agents` row if present so the
        // harness side stays consistent with cherry-coke's canvas.
        if (existing.agentId) {
            const normalized = ctx.db.normalizeId("agents", existing.agentId);
            if (normalized) {
                const agent = await ctx.db.get(normalized);
                if (agent) await ctx.db.delete(normalized);
            }
        }

        await ctx.db.delete(configId);

        return configId;
    },
});
