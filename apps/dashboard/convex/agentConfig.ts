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
 * Update an agent config's editable fields.
 * @param configId Agent config ID
 * @param name Optional new display name
 * @returns null
 * @throws Error if user is not authenticated or does not own the config
 */
export const update = mutation({
  args: {
    configId: v.id("agentConfigs"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { configId, name, description, systemPrompt } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const config = await ctx.db.get(configId);
    if (!config || config.authId !== user.subject) {
      throw new Error("Agent config not found or access denied");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;

    await ctx.db.patch(configId, patch);

    // Also update the canvas node label if name changed
    if (name !== undefined) {
      const layout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
          q.eq("projectId", config.projectId).eq("environmentId", config.environmentId),
        )
        .first();

      if (layout) {
        const updatedNodes = layout.nodes.map((n) =>
          n.data.agentConfigId === configId
            ? { ...n, data: { ...n.data, label: name } }
            : n,
        );
        await ctx.db.patch(layout._id, { nodes: updatedNodes, updatedAt: Date.now() });
      }
    }

    return null;
  },
});

/**
 * Delete an agent config and all related data (deployments, connections, sessions, messages, tasks, memories, canvas node).
 * @param configId Agent config ID
 * @returns null
 * @throws Error if user is not authenticated or does not own the config
 */
export const remove = mutation({
  args: {
    configId: v.id("agentConfigs"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { configId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const config = await ctx.db.get(configId);
    if (!config || config.authId !== user.subject) {
      throw new Error("Agent config not found or access denied");
    }

    // Delete sessions and their nested data (messages, tasks, toolApprovals)
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_configId", (q) => q.eq("configId", configId))
      .collect();

    for (const session of sessions) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const msg of messages) {
        await ctx.db.delete(msg._id);
      }

      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const task of tasks) {
        await ctx.db.delete(task._id);
      }

      const approvals = await ctx.db
        .query("toolApprovals")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const approval of approvals) {
        await ctx.db.delete(approval._id);
      }

      await ctx.db.delete(session._id);
    }

    // Delete deployments
    const deployments = await ctx.db
      .query("agentDeployments")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
      .collect();
    for (const dep of deployments) {
      await ctx.db.delete(dep._id);
    }

    // Delete connections
    const connections = await ctx.db
      .query("agentConnections")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
      .collect();
    for (const conn of connections) {
      await ctx.db.delete(conn._id);
    }

    // Remove the canvas node referencing this config
    const layout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", config.projectId).eq("environmentId", config.environmentId),
      )
      .first();

    if (layout) {
      const filteredNodes = layout.nodes.filter((n) => n.data.agentConfigId !== configId);
      const removedNodeIds = new Set(
        layout.nodes.filter((n) => n.data.agentConfigId === configId).map((n) => n.id),
      );
      const filteredEdges = layout.edges.filter(
        (e) => !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target),
      );
      await ctx.db.patch(layout._id, {
        nodes: filteredNodes,
        edges: filteredEdges,
        updatedAt: Date.now(),
      });
    }

    await ctx.db.delete(configId);

    return null;
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
 * List all agent configs for a project (non-subagent only).
 * @param projectId Project to list configs for
 * @returns Agent config documents
 * @throws Error if user is not authenticated or does not own the project
 */
export const listByProject = query({
  args: {
    projectId: v.id("projects"),
  },
  returns: v.array(agentConfigValidator),
  handler: async (ctx, args) => {
    const { projectId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    return configs.filter((c) => c.authId === user.subject && !c.isSubAgent);
  },
});

/**
 * Resolve available subagents for a parent config in gateway execution.
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


