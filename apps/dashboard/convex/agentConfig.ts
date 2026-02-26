/**
 * Agent config mutations and queries for managing AI agent configurations.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { assertGatewaySecret } from "./model/gateway";
import { resolveConnectedSubAgents } from "./model/agentConfig";
import { agentConfigFields } from "./schema";
import { verifyProjectOwnership } from "./model/ownership";

/** Validator for agent config records with system fields. */
const agentConfigValidator = v.object(withSystemFields("agentConfigs", agentConfigFields));

/**
 * Create a new agent config and add a corresponding agent node to the project canvas.
 * @param projectId The project this agent belongs to
 * @param environmentId The environment to scope this agent to
 * @param name Display name for the agent
 * @param modelId The AI model identifier
 * @param description Optional description of the agent's purpose
 * @param systemPrompt Optional system prompt for the agent
 * @returns Object with the new agentConfigId and the canvas nodeId
 * @throws Error if user is not authenticated or does not own the project
 */
export const create = mutation({
  args: {
    projectId: agentConfigFields.projectId,
    environmentId: agentConfigFields.environmentId,
    name: agentConfigFields.name,
    modelId: agentConfigFields.modelId,
    description: agentConfigFields.description,
    systemPrompt: agentConfigFields.systemPrompt,
  },
  returns: v.object({
    agentConfigId: v.id("agentConfigs"),
    nodeId: v.string(),
  }),
  handler: async (ctx, args) => {
    const { projectId, environmentId, name, modelId, description, systemPrompt } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Verify the user owns this project
    await verifyProjectOwnership(ctx, projectId, user.subject);

    // Insert the agent config
    const agentConfigId = await ctx.db.insert("agentConfigs", {
      authId: user.subject,
      projectId: projectId,
      environmentId: environmentId,
      name: name,
      modelId: modelId,
      description: description,
      systemPrompt: systemPrompt,
      permissionMode: "default",
      isSubAgent: false,
      updatedAt: Date.now(),
    });

    // Upsert canvas layout for this environment: append a new agent node
    const existingLayout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId),
      )
      .first();

    const existingNodes = existingLayout?.nodes ?? [];
    const existingEdges = existingLayout?.edges ?? [];

    // Compute next numeric node ID
    const maxId = existingNodes.reduce(
      (max, n) => Math.max(max, Number(n.id) || 0),
      0,
    );
    const nodeId = String(maxId + 1);

    // Position: offset horizontally for each additional node
    const position = {
      x: existingNodes.length * 250,
      y: 100,
    };

    const newNode = {
      id: nodeId,
      type: "agent" as const,
      position: position,
      data: {
        label: name,
        status: "idle" as const,
        agentConfigId: agentConfigId,
      },
    };

    if (existingLayout) {
      await ctx.db.patch(existingLayout._id, {
        nodes: [...existingNodes, newNode],
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("canvasLayouts", {
        authId: user.subject,
        projectId: projectId,
        environmentId: environmentId,
        nodes: [newNode],
        edges: existingEdges,
        updatedAt: Date.now(),
      });
    }

    return { agentConfigId: agentConfigId, nodeId: nodeId };
  },
});

/**
 * Get an agent config by ID for the authenticated user.
 * @param configId Agent config ID
 * @returns Agent config document, or null if not found/unauthorized
 */
export const getById = query({
  args: {
    configId: v.id("agentConfigs"),
  },
  returns: v.union(agentConfigValidator, v.null()),
  handler: async (ctx, args) => {
    const { configId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const config = await ctx.db.get(configId);
    if (!config || config.authId !== user.subject) {
      return null;
    }

    return config;
  },
});

/**
 * Get an agent config by ID for internal orchestration.
 * @param configId Agent config ID
 * @returns Agent config document
 * @throws Error if config does not exist
 */
export const getByIdInternal = internalQuery({
  args: {
    configId: v.id("agentConfigs"),
  },
  returns: agentConfigValidator,
  handler: async (ctx, args) => {
    const { configId } = args;
    const config = await ctx.db.get(configId);
    if (!config) {
      throw new Error("Agent config not found");
    }

    return config;
  },
});

/**
 * Resolve available subagents for a parent config in gateway execution.
 * Uses explicit agentConnections first; falls back to same project/environment subagents.
 * @param gatewaySecret Shared gateway secret
 * @param parentConfigId Parent agent config ID
 * @returns Available subagent config summaries
 */
export const getSubAgentsForGateway = query({
  args: {
    gatewaySecret: v.string(),
    parentConfigId: v.id("agentConfigs"),
  },
  returns: v.array(agentConfigValidator),
  handler: async (ctx, args) => {
    const { gatewaySecret, parentConfigId } = args;
    assertGatewaySecret(gatewaySecret);

    const parentConfig = await ctx.db.get(parentConfigId);
    if (!parentConfig) {
      return [];
    }

    const connectedSubAgents = await resolveConnectedSubAgents(ctx, parentConfigId, parentConfig.authId);
    if (connectedSubAgents.length > 0) {
      return connectedSubAgents;
    }

    const projectConfigs = parentConfig.environmentId
      ? await ctx.db
          .query("agentConfigs")
          .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", parentConfig.projectId).eq("environmentId", parentConfig.environmentId),
          )
          .collect()
      : await ctx.db
          .query("agentConfigs")
          .withIndex("by_projectId", (q) => q.eq("projectId", parentConfig.projectId))
          .collect();

    return projectConfigs.filter(
      (config) =>
        config.authId === parentConfig.authId &&
        config.isSubAgent &&
        config._id !== parentConfig._id &&
        config.environmentId === parentConfig.environmentId,
    );
  },
});


