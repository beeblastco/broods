/**
 * Temporary agent config API with minimal persistence for canvas UI.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
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

/**
 * Loads an agent config owned by the authenticated user.
 * @param configId Agent config document id
 * @returns Agent config document or null when not found
 */
export const getById = query({
    args: {
        configId: v.id("agentConfigs"),
    },
    returns: v.union(v.null(), agentConfigDoc),
    handler: async (ctx, args) => {
        const { configId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const config = await ctx.db.get(configId);
        if (!config || config.authId !== authUser.id) {
            return null;
        }

        return config;
    },
});

/**
 * Creates a minimal agent config for the canvas.
 * @param projectId Parent project id
 * @param environmentId Target environment id
 * @param name Display name
 * @returns New agent config document id
 */
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
        const { projectId, environmentId, name, provider, modelId, description, systemPrompt, position } =
            args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) {
            throw new Error("Project not found.");
        }

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const now = Date.now();
        const configId = await ctx.db.insert("agentConfigs", {
            authId: authUser.id,
            name: name.trim(),
            description: description?.trim() || undefined,
            agentId: undefined,
            projectId: projectId,
            environmentId: environmentId,
            provider: provider,
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

            const nodeId = String(Date.now());
            const nextNode = {
                id: nodeId,
                type: "agent" as const,
                position: position,
                data: {
                    label: name.trim(),
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
                    projectId: projectId,
                    environmentId: environmentId,
                    nodes: [nextNode],
                    edges: [],
                    updatedAt: now,
                });
            }
        }

        return configId;
    },
});

/**
 * Updates editable agent config fields for the authenticated owner.
 * @param configId Agent config document id
 * @returns Updated agent config document id
 */
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
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, args) => {
        const { configId, ...updates } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const existing = await ctx.db.get(configId);
        if (!existing || existing.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        const patch: Record<string, unknown> = { updatedAt: Date.now() };
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                patch[key] = value;
            }
        }

        await ctx.db.patch(configId, patch);

        return configId;
    },
});

/**
 * Permanently deletes an agent config owned by the authenticated user.
 * @param configId Agent config document id
 * @returns Deleted agent config document id
 */
export const remove = mutation({
    args: {
        configId: v.id("agentConfigs"),
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, args) => {
        const { configId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const existing = await ctx.db.get(configId);
        if (!existing || existing.authId !== authUser.id) {
            throw new Error("Agent config not found.");
        }

        const deployments = await ctx.db
            .query("agentDeployments")
            .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
            .collect();

        for (const deployment of deployments) {
            await ctx.db.delete(deployment._id);
        }

        await ctx.db.delete(configId);

        return configId;
    },
});
