/**
 * Agent config mutations and queries for managing AI agent configurations.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { agentConfigFields } from "./schema";
import { verifyProjectOwnership } from "./model/ownership/index";

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
    const existingLayout = environmentId
      ? await ctx.db
          .query("canvasLayouts")
          .withIndex("by_projectId_and_environmentId", (q) =>
            q.eq("projectId", projectId).eq("environmentId", environmentId),
          )
          .first()
      : await ctx.db
          .query("canvasLayouts")
          .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
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
