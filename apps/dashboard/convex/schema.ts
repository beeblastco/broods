import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Field definitions for the users table.
 * Synced from WorkOS AuthKit webhooks with app-specific extensions.
 */
export const usersFields = {
    authId: v.string(),
    email: v.string(),
    name: v.string(),
    avatarUrl: v.optional(v.string()),
    accountHandle: v.optional(v.string()),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    deletionScheduledFor: v.optional(v.number()),
};

export const projectsFields = {
    authId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    slug: v.string(),
    updatedAt: v.number(),
};

export const environmentsFields = {
    authId: v.string(),
    projectId: v.id("projects"),
    name: v.string(),
    isDefault: v.boolean(),
    updatedAt: v.number(),
};

/** Minimal agent config fields; extra UI settings are stored as optional fields. */
export const agentConfigsFields = {
    authId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    agentId: v.optional(v.string()),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    provider: v.optional(v.string()),
    modelId: v.optional(v.string()),
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
    updatedAt: v.number(),
};

export const canvasLayoutsFields = {
    authId: v.string(),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodes: v.array(v.any()),
    edges: v.array(v.any()),
    updatedAt: v.number(),
};

export const agentDeploymentsFields = {
    authId: v.string(),
    agentConfigId: v.id("agentConfigs"),
    status: v.union(v.literal("active"), v.literal("revoked")),
    endpointId: v.string(),
    projectSlug: v.string(),
    environmentSlug: v.string(),
    apiKey: v.optional(v.string()),
    updatedAt: v.number(),
};

export const toolServicesFields = {
    authId: v.string(),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
    nodeLabel: v.string(),
    language: v.union(v.literal("javascript"), v.literal("python")),
    sourceCode: v.string(),
    status: v.union(v.literal("enabled"), v.literal("disabled")),
    updatedAt: v.number(),
};



export default defineSchema({
    users: defineTable(usersFields)
        .index("by_authId", ["authId"])
        .index("by_accountHandle", ["accountHandle"]),
    projects: defineTable(projectsFields)
        .index("by_authId", ["authId"])
        .index("by_authId_and_slug", ["authId", "slug"]),
    environments: defineTable(environmentsFields)
        .index("by_projectId", ["projectId"])
        .index("by_authId_and_projectId", ["authId", "projectId"]),
    agentConfigs: defineTable(agentConfigsFields)
        .index("by_authId", ["authId"])
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"]),
    canvasLayouts: defineTable(canvasLayoutsFields)
        .index("by_projectId_and_environmentId", ["projectId", "environmentId"]),
    agentDeployments: defineTable(agentDeploymentsFields)
        .index("by_agentConfigId", ["agentConfigId"])
        .index("by_authId", ["authId"]),
    toolServices: defineTable(toolServicesFields)
        .index("by_projectId_environmentId_and_nodeId", [
            "projectId",
            "environmentId",
            "nodeId",
        ]),
});
