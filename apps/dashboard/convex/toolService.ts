/**
 * Tool service queries and mutations for custom JS/TS sandbox tools.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import {
  defaultToolSourceCode,
  makeUniqueToolName,
  normalizeToolName,
  syncAgentToolPermissionsForEnvironment,
} from "./model/toolService";
import { verifyProjectOwnership } from "./model/ownership";
import { toolServiceFields } from "./schema";

/** Validator for tool service records with system fields. */
const toolServiceValidator = v.object(withSystemFields("toolServices", toolServiceFields));

/** Maximum accepted source code payload size per tool. */
const MAX_TOOL_SOURCE_BYTES = 200_000;

/**
 * Get a tool service by canvas node in a project environment.
 */
export const getByNode = query({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
  },
  returns: v.union(toolServiceValidator, v.null()),
  handler: async (ctx, args) => {
    const { projectId, environmentId, nodeId } = args;

    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    const toolService = await ctx.db
      .query("toolServices")
      .withIndex("by_projectId_and_environmentId_and_nodeId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId).eq("nodeId", nodeId),
      )
      .first();

    if (!toolService || toolService.authId !== user.subject) {
      return null;
    }

    return toolService;
  },
});

/**
 * Create or update a tool service bound to a canvas node.
 * Name is derived from node label at create-time; code/status updates can be done later.
 */
export const upsertForNode = mutation({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
    nodeLabel: v.string(),
    description: v.optional(v.string()),
    parameters: v.optional(v.any()),
    status: v.optional(toolServiceFields.status),
    language: v.optional(toolServiceFields.language),
    sourceCode: v.optional(v.string()),
  },
  returns: toolServiceValidator,
  handler: async (ctx, args) => {
    const { projectId, environmentId, nodeId, nodeLabel, description, parameters, status, language, sourceCode } = args;

    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    if (sourceCode !== undefined && sourceCode.trim().length === 0) {
      throw new Error("Tool source code cannot be empty");
    }
    if (sourceCode !== undefined && sourceCode.length > MAX_TOOL_SOURCE_BYTES) {
      throw new Error("Tool source code exceeds maximum size");
    }

    const existing = await ctx.db
      .query("toolServices")
      .withIndex("by_projectId_and_environmentId_and_nodeId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId).eq("nodeId", nodeId),
      )
      .first();

    if (existing) {
      if (existing.authId !== user.subject) {
        throw new Error("Access denied");
      }

      const patch: {
        description?: string;
        parameters?: unknown;
        status?: "enabled" | "disabled";
        language?: "javascript" | "python";
        sourceCode?: string;
        updatedAt?: number;
      } = {};
      const statusChanged = status !== undefined && status !== existing.status;

      if (description !== undefined) {
        patch.description = description;
      }
      if (parameters !== undefined) {
        patch.parameters = parameters;
      }
      if (status !== undefined) {
        patch.status = status;
      }
      if (language !== undefined) {
        patch.language = language;
      }
      if (sourceCode !== undefined) {
        patch.sourceCode = sourceCode;
      }

      if (Object.keys(patch).length > 0) {
        patch.updatedAt = Date.now();
        await ctx.db.patch(existing._id, patch);
      }

      if (statusChanged) {
        await syncAgentToolPermissionsForEnvironment(ctx, {
          projectId: projectId,
          environmentId: environmentId,
        });
      }

      const updated = await ctx.db.get(existing._id);
      if (!updated) {
        throw new Error("Tool service not found");
      }

      return updated;
    }

    const environmentTools = await ctx.db
      .query("toolServices")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId),
      )
      .collect();
    const usedNames = new Set(environmentTools.map((tool) => tool.name));
    const baseName = normalizeToolName(nodeLabel);
    const uniqueName = makeUniqueToolName(baseName, usedNames);
    const nextLanguage = language ?? "javascript";
    const nextSourceCode = sourceCode ?? defaultToolSourceCode(nextLanguage);

    const toolServiceId = await ctx.db.insert("toolServices", {
      authId: user.subject,
      projectId: projectId,
      environmentId: environmentId,
      nodeId: nodeId,
      name: uniqueName,
      description: description,
      parameters: parameters,
      status: status ?? "enabled",
      language: nextLanguage,
      sourceCode: nextSourceCode,
      updatedAt: Date.now(),
    });

    await syncAgentToolPermissionsForEnvironment(ctx, {
      projectId: projectId,
      environmentId: environmentId,
    });

    const inserted = await ctx.db.get(toolServiceId);
    if (!inserted) {
      throw new Error("Tool service not found");
    }

    return inserted;
  },
});

/**
 * Resolve tool services connected to an agent for gateway execution.
 */
export const getConnectedForGateway = internalQuery({
  args: {
    agentConfigId: v.id("agentConfigs"),
  },
  returns: v.array(toolServiceValidator),
  handler: async (ctx, args) => {
    const { agentConfigId } = args;

    const agentConfig = await ctx.db.get(agentConfigId);
    if (!agentConfig) {
      return [];
    }

    const connections = await ctx.db
      .query("agentConnections")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", agentConfigId))
      .collect();
    const connectedToolNodeIds = new Set(
      connections
        .filter((connection) => connection.targetType === "tool")
        .map((connection) => connection.targetId),
    );

    if (connectedToolNodeIds.size === 0) {
      return [];
    }

    const environmentTools = await ctx.db
      .query("toolServices")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", agentConfig.projectId).eq("environmentId", agentConfig.environmentId),
      )
      .collect();

    return environmentTools
      .filter(
        (toolService) =>
          toolService.authId === agentConfig.authId &&
          connectedToolNodeIds.has(toolService.nodeId),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
