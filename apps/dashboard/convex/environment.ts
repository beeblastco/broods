/**
 * Environment queries and mutations for managing project deployment environments.
 * Each project has a default "Production" environment; additional environments can be
 * created empty or duplicated from an existing one.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { environmentFields } from "./schema";
import { verifyProjectOwnership, verifyEnvironmentOwnership } from "./model/ownership";
import { createDeploymentForConfig } from "./model/agentDeployment";
import type { Id } from "./_generated/dataModel";

/** Validator for environment records with system fields. */
const environmentValidator = v.object(withSystemFields("environments", environmentFields));

/**
 * List all environments for a given project.
 * @param projectId The project to fetch environments for
 * @returns Array of environment documents
 */
export const list = query({
  args: {
    projectId: v.id("projects"),
  },
  returns: v.array(environmentValidator),
  handler: async (ctx, args) => {
    const { projectId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Return empty if project was deleted (e.g. during navigation after remove)
    const project = await ctx.db.get(projectId);
    if (!project || project.authId !== user.subject) {
      return [];
    }

    const environments = await ctx.db
      .query("environments")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    return environments;
  },
});

/**
 * Ensure a default "Production" environment exists for the project.
 * Migrates any existing agentConfigs and canvasLayouts with no environmentId to the production env.
 * @param projectId The project to ensure production environment for
 * @returns The production environment ID, or null if the project no longer exists
 * @throws Error if user is not authenticated or does not own the project
 */
export const ensureDefault = mutation({
  args: {
    projectId: v.id("projects"),
  },
  returns: v.union(v.id("environments"), v.null()),
  handler: async (ctx, args) => {
    const { projectId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Return null silently if the project was deleted (e.g. user navigated away after delete)
    const project = await ctx.db.get(projectId);
    if (!project || project.authId !== user.subject) {
      return null;
    }

    // Return existing default environment if already created
    const existing = await ctx.db
      .query("environments")
      .withIndex("by_projectId_and_isDefault", (q) =>
        q.eq("projectId", projectId).eq("isDefault", true),
      )
      .first();

    if (existing) {
      return existing._id;
    }

    // Create the Production environment
    const environmentId = await ctx.db.insert("environments", {
      authId: user.subject,
      projectId: projectId,
      name: "production",
      isDefault: true,
      updatedAt: Date.now(),
    });

    // Migrate legacy agentConfigs (no environmentId) to production
    const legacyConfigs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    for (const config of legacyConfigs) {
      if (!config.environmentId) {
        await ctx.db.patch(config._id, { environmentId: environmentId });
      }
    }

    // Migrate legacy canvasLayouts (no environmentId) to production
    const legacyLayouts = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    for (const layout of legacyLayouts) {
      if (!layout.environmentId) {
        await ctx.db.patch(layout._id, { environmentId: environmentId });
      }
    }

    return environmentId;
  },
});

/**
 * Create a new named environment, optionally duplicating configs and canvas from an existing one.
 * @param projectId The project to create the environment in
 * @param name Display name for the new environment
 * @param duplicateFromId Optional environment ID to copy agentConfigs and canvas from
 * @returns The new environment ID
 * @throws Error if user is not authenticated, does not own the project, or name is empty
 */
export const create = mutation({
  args: {
    projectId: v.id("projects"),
    name: environmentFields.name,
    duplicateFromId: v.optional(v.id("environments")),
  },
  returns: v.id("environments"),
  handler: async (ctx, args) => {
    const { projectId, name, duplicateFromId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    if (duplicateFromId) {
      await verifyEnvironmentOwnership(ctx, duplicateFromId, user.subject);
    }

    // Create the new environment
    const environmentId = await ctx.db.insert("environments", {
      authId: user.subject,
      projectId: projectId,
      name: name,
      isDefault: false,
      updatedAt: Date.now(),
    });

    if (duplicateFromId) {
      // Copy agentConfigs from source environment and build ID remap table
      const sourceConfigs = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) =>
          q.eq("projectId", projectId).eq("environmentId", duplicateFromId),
        )
        .collect();

      const configIdMap = new Map<Id<"agentConfigs">, Id<"agentConfigs">>();
      const environmentSlug = name.toLowerCase().replace(/\s+/g, "-");

      for (const config of sourceConfigs) {
        const newConfigId = await ctx.db.insert("agentConfigs", {
          authId: user.subject,
          projectId: projectId,
          environmentId: environmentId,
          name: config.name,
          modelId: config.modelId,
          description: config.description,
          systemPrompt: config.systemPrompt,
          maxTurns: config.maxTurns,
          allowedTools: config.allowedTools,
          disallowedTools: config.disallowedTools,
          permissionMode: config.permissionMode,
          outputFormat: config.outputFormat,
          providerOptions: config.providerOptions,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          isSubAgent: config.isSubAgent,
          updatedAt: Date.now(),
        });

        configIdMap.set(config._id, newConfigId);

        // Auto-deploy the duplicated config with the new environment's slug
        await createDeploymentForConfig(ctx, user.subject, newConfigId, environmentSlug);
      }

      // Copy canvas layout from source environment, remapping agentConfigIds
      const sourceLayout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
          q.eq("projectId", projectId).eq("environmentId", duplicateFromId),
        )
        .first();

      if (sourceLayout) {
        const newNodes = sourceLayout.nodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            agentConfigId: node.data.agentConfigId
              ? (configIdMap.get(node.data.agentConfigId) ?? node.data.agentConfigId)
              : undefined,
          },
        }));

        await ctx.db.insert("canvasLayouts", {
          authId: user.subject,
          projectId: projectId,
          environmentId: environmentId,
          nodes: newNodes,
          edges: sourceLayout.edges,
          updatedAt: Date.now(),
        });
      }
    }

    return environmentId;
  },
});

/**
 * Delete a non-default environment and schedule background cleanup of associated data.
 * @param environmentId The environment to delete
 * @throws Error if user is not authenticated, does not own the environment, or it is the default
 */
export const remove = mutation({
  args: {
    environmentId: v.id("environments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { environmentId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const environment = await verifyEnvironmentOwnership(ctx, environmentId, user.subject);

    if (environment.isDefault) {
      throw new Error("Cannot delete the default environment");
    }

    // Delete the environment record immediately so UI updates without waiting
    await ctx.db.delete(environmentId);

    // Schedule heavy cleanup in the background for better UX
    await ctx.scheduler.runAfter(0, internal.environment.removeCleanupInternal, {
      projectId: environment.projectId,
      environmentId: environmentId,
    });

    return null;
  },
});

/**
 * Background cleanup for all data related to a deleted environment.
 * Deletes agent configs (and their sessions/messages/tasks/approvals/deployments/connections)
 * and canvas layouts scoped to the deleted environment.
 * @param projectId The project that owned the deleted environment
 * @param environmentId The deleted environment ID
 */
export const removeCleanupInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId, environmentId } = args;

    // Delete associated agentConfigs and their related data
    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q
          .eq("projectId", projectId)
          .eq("environmentId", environmentId),
      )
      .collect();

    for (const config of configs) {
      // Delete sessions and nested data (messages, tasks, approvals)
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_configId", (q) => q.eq("configId", config._id))
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

      // Delete deployments for the config
      const deployments = await ctx.db
        .query("agentDeployments")
        .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
        .collect();
      for (const dep of deployments) {
        await ctx.db.delete(dep._id);
      }

      // Delete connections for the config
      const connections = await ctx.db
        .query("agentConnections")
        .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
        .collect();
      for (const conn of connections) {
        await ctx.db.delete(conn._id);
      }

      await ctx.db.delete(config._id);
    }

    // Delete associated canvas layout
    const layouts = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q
          .eq("projectId", projectId)
          .eq("environmentId", environmentId),
      )
      .collect();

    for (const layout of layouts) {
      await ctx.db.delete(layout._id);
    }

    return null;
  },
});
