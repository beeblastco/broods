/**
 * Agent config CRUD for the canvas UI. Scoped to authenticated user.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { ensureAgentsRowForConfig, pushEncryptedConfigToAgentRow, syncAgentRowFields } from "./model/agentSync";
import { scheduleServiceLog } from "./observability";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { saveAgentRuntimeSecrets } from "./model/agentRuntimeSecrets";
import { agentConfigsFields } from "./schema";

const agentProviderValidator = v.union(
    v.literal("openai"),
    v.literal("google"),
    v.literal("bedrock"),
    v.literal("anthropic"),
    v.literal("minimax"),
    v.literal("gateway"),
);

const agentConfigDoc = v.object({
    ...agentConfigsFields,
    _id: v.id("agentConfigs"),
    _creationTime: v.number(),
});

const workspaceRefValidator = v.object({
    name: v.string(),
    workspaceId: v.string(),
    sandbox: v.optional(v.union(v.string(), v.null())),
});

const MASKED_RUNTIME_VARIABLE_VALUE = "";

/** Coerces unknown JSON-ish values into a mutable record for patching. */
function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

/** Hide secret values from browser reads while preserving variable names. */
function maskRuntimeVariables<T extends { runtimeVariables?: Array<{ key: string; value: string }> }>(
    config: T,
): T {
    return {
        ...config,
        runtimeVariables: config.runtimeVariables?.map((entry) => ({
            key: entry.key,
            value: MASKED_RUNTIME_VARIABLE_VALUE,
        })),
    };
}

/** Returns true when the caller may edit a project-scoped agent config. */
async function canAccessAgentConfig(
    ctx: Parameters<typeof getOwnedProject>[0],
    authId: string,
    config: { projectId: Id<"projects"> },
): Promise<boolean> {
    return Boolean(await getOwnedProject(ctx, authId, config.projectId));
}

export const getById = query({
    args: { configId: v.id("agentConfigs") },
    returns: v.union(v.null(), agentConfigDoc),
    handler: async (ctx, { configId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const config = await ctx.db.get(configId);
        if (!config || !(await canAccessAgentConfig(ctx, authUser.id, config))) return null;

        return maskRuntimeVariables(config);
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
        await pushEncryptedConfigToAgentRow(ctx, configId);
        const created = await ctx.db.get(configId);
        await scheduleServiceLog(ctx, {
            projectId: projectId,
            environmentId: environmentId,
            eventType: "service.agent.created",
            message: "Agent configuration created",
            agentId: created?.agentId,
            data: { configId: configId, name: trimmedName },
        });

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
        memoryToolEnabled: v.optional(v.boolean()),
        searchToolEnabled: v.optional(v.boolean()),
        searchToolConfig: v.optional(v.any()),
        runtimeVariables: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
        agentId: v.optional(v.string()),
        extraConfig: v.optional(v.any()),
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, args) => {
        const { configId, ...updates } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const existing = await ctx.db.get(configId);
        if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
            throw new Error("Agent config not found.");
        }

        const patch = Object.fromEntries(
            Object.entries(updates)
                .filter(([, v]) => v !== undefined)
                .map(([key, value]) => [key, key === "outputFormat" && value === null ? undefined : value]),
        );
        if (Array.isArray(patch.runtimeVariables)) {
            patch.runtimeVariables = await saveAgentRuntimeSecrets(
                ctx,
                configId,
                patch.runtimeVariables as Array<{ key: string; value: string }>,
            );
        }

        await ctx.db.patch(configId, { ...patch, updatedAt: Date.now() });

        // Keep the filthy-panty `agents` row aligned; this also provisions
        // the runtime row when an org account was created after the config.
        await ensureAgentsRowForConfig(ctx, configId, user.id);
        await syncAgentRowFields(ctx, configId, {
            name: updates.name,
            description: updates.description,
        });
        await pushEncryptedConfigToAgentRow(ctx, configId);
        const updated = await ctx.db.get(configId);
        await scheduleServiceLog(ctx, {
            projectId: existing.projectId,
            environmentId: existing.environmentId,
            eventType: "service.agent.config.updated",
            message: "Agent configuration updated",
            agentId: updated?.agentId,
            data: { configId: configId, changedFields: Object.keys(patch).sort() },
        });

        return configId;
    },
});

/**
 * Updates the filthy-panty runtime resource references derived from the canvas graph.
 * This preserves unrelated extraConfig branches while replacing sandbox/workspaces.
 */
export const updateRuntimeRefs = mutation({
    args: {
        configId: v.id("agentConfigs"),
        sandbox: v.union(v.string(), v.null()),
        workspaces: v.union(v.array(workspaceRefValidator), v.null()),
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, args) => {
        const { configId, sandbox, workspaces } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const existing = await ctx.db.get(configId);
        if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
            throw new Error("Agent config not found.");
        }

        const extraConfig = { ...asRecord(existing.extraConfig) };
        if (sandbox) {
            extraConfig.sandbox = sandbox;
        } else {
            delete extraConfig.sandbox;
        }
        if (workspaces && workspaces.length > 0) {
            extraConfig.workspaces = workspaces;
        } else {
            delete extraConfig.workspaces;
        }
        // Old nested AgentWorkspaceConfig is no longer part of filthy-panty's runtime contract.
        delete extraConfig.workspace;

        await ctx.db.patch(configId, {
            extraConfig: extraConfig,
            updatedAt: Date.now(),
        });

        await ensureAgentsRowForConfig(ctx, configId, user.id);
        await pushEncryptedConfigToAgentRow(ctx, configId);

        return configId;
    },
});

/**
 * Updates the filthy-panty `subagent.allowed` branch for one caller agent from the
 * canvas's agent→agent edges. Resolves each callee config's linked `agentId`
 * (provisioning its `agents` row when missing) into the allow-list, enabling
 * subagent calls when non-empty and clearing the branch when empty.
 */
export const updateSubagentRefs = mutation({
    args: {
        configId: v.id("agentConfigs"),
        calleeConfigIds: v.array(v.id("agentConfigs")),
    },
    returns: v.id("agentConfigs"),
    handler: async (ctx, args) => {
        const { configId, calleeConfigIds } = args;

        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const existing = await ctx.db.get(configId);
        if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
            throw new Error("Agent config not found.");
        }

        // Map each callee config to its filthy-panty agents-row id, skipping
        // self-calls and any config the caller doesn't own or can't provision.
        const allowed: string[] = [];
        for (const calleeId of calleeConfigIds) {
            if (calleeId === configId) continue;
            const callee = await ctx.db.get(calleeId);
            if (!callee || !(await canAccessAgentConfig(ctx, user.id, callee))) continue;
            const agentRowId = await ensureAgentsRowForConfig(ctx, calleeId, user.id);
            if (agentRowId) allowed.push(agentRowId);
        }
        allowed.sort();

        const extraConfig = { ...asRecord(existing.extraConfig) };
        const prevSubagent = asRecord(extraConfig.subagent);
        // Preserve any context/mode the caller already set; only swap enabled+allowed.
        const nextSubagent =
            allowed.length > 0 ? { ...prevSubagent, enabled: true, allowed: allowed } : undefined;

        // Skip the patch and encryption push entirely when the branch is unchanged.
        if (JSON.stringify(extraConfig.subagent ?? null) === JSON.stringify(nextSubagent ?? null)) {
            return configId;
        }

        if (nextSubagent) {
            extraConfig.subagent = nextSubagent;
        } else {
            delete extraConfig.subagent;
        }

        await ctx.db.patch(configId, { extraConfig: extraConfig, updatedAt: Date.now() });

        await ensureAgentsRowForConfig(ctx, configId, user.id);
        await pushEncryptedConfigToAgentRow(ctx, configId);

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
        if (!existing || !(await canAccessAgentConfig(ctx, authUser.id, existing))) {
            throw new Error("Agent config not found.");
        }

        // Code is the source of truth for CLI-managed agents: the dashboard may
        // edit them (changes are overwritten on the next sync) but must not delete
        // them. Removal happens by deleting them from `filthypanty/` and running
        // `filthy-panty deploy --prune`.
        if (existing.managedBy === "cli") {
            throw new Error("This agent is managed by code. Remove it from your project and run `filthy-panty deploy --prune` to delete it.");
        }

        // Note: the environment's runtime API key is shared across all its agents
        // (env-scoped), so deleting one agent config must NOT delete it. The key is
        // only removed when the whole environment is deleted (see environment.ts).

        // Clean up the linked filthy-panty `agents` row if present so the
        // harness side stays consistent with the dashboard's canvas.
        if (existing.agentId) {
            const normalized = ctx.db.normalizeId("agents", existing.agentId);
            if (normalized) {
                const agent = await ctx.db.get(normalized);
                if (agent) await ctx.db.delete(normalized);
            }
        }

        await scheduleServiceLog(ctx, {
            projectId: existing.projectId,
            environmentId: existing.environmentId,
            eventType: "service.agent.deleted",
            message: "Agent configuration deleted",
            agentId: existing.agentId,
            data: { configId: configId, name: existing.name },
        });
        await ctx.db.delete(configId);

        return configId;
    },
});
