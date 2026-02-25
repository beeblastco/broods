/**
 * Project queries and mutations for workspace management.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  canvasEdgeValidator,
  canvasNodeValidator,
  projectFields,
} from "./schema";
import { verifyProjectOwnership } from "./model/ownership/index";

/** Validator for project records with system fields. */
const projectValidator = v.object(withSystemFields("projects", projectFields));

/**
 * List all projects owned by the authenticated user.
 * @returns Array of project documents
 */
export const list = query({
  args: {},
  returns: v.array(projectValidator),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .collect();

    return projects;
  },
});

/**
 * Create a new project for the authenticated user.
 * @param name Display name for the project
 * @param description Optional project description
 * @returns The new project document ID
 * @throws Error if user is not authenticated or slug already exists
 */
export const create = mutation({
  args: {
    name: projectFields.name,
    description: projectFields.description,
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const { name, description } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const projectId = await ctx.db.insert("projects", {
      authId: user.subject,
      name: name,
      description: description,
      slug: slug,
      updatedAt: Date.now(),
    });

    return projectId;
  },
});

/**
 * Get a single project by ID for the authenticated user.
 * @param projectId The project to fetch
 * @returns The project document, or null if not found or unauthorized
 */
export const getById = query({
  args: {
    projectId: v.id("projects"),
  },
  returns: v.union(
    v.object(withSystemFields("projects", projectFields)),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const { projectId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await ctx.db.get(projectId);
    if (!project || project.authId !== user.subject) {
      return null;
    }

    return project;
  },
});

/**
 * Update a project's name and/or description.
 * Regenerates the slug if the name changes.
 * @param projectId The project to update
 * @param name Optional new display name
 * @param description Optional new description (pass empty string to clear)
 * @throws Error if user is not authenticated or does not own the project
 */
export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(projectFields.name),
    description: v.optional(projectFields.description),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId, name, description } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    const patch: {
      updatedAt: number;
      name?: string;
      slug?: string;
      description?: string;
    } = {
      updatedAt: Date.now(),
    };

    if (name !== undefined) {
      patch.name = name;
      patch.slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    }

    if (description !== undefined) {
      patch.description = description === "" ? undefined : description;
    }

    await ctx.db.patch(projectId, patch);

    return null;
  },
});

/**
 * List all projects with their canvas preview data for the dashboard.
 * Fetches the first available canvas layout per project for thumbnail rendering.
 * @returns Array of projects each with optional nodes/edges canvas data
 */
export const listWithPreview = query({
  args: {},
  returns: v.array(
    v.object({
      ...withSystemFields("projects", projectFields),
      canvas: v.union(
        v.object({
          nodes: v.array(canvasNodeValidator),
          edges: v.array(canvasEdgeValidator),
        }),
        v.null(),
      ),
    }),
  ),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .collect();

    const results = await Promise.all(
      projects.map(async (project) => {
        const layout = await ctx.db
          .query("canvasLayouts")
          .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
          .first();

        return {
          ...project,
          canvas: layout ? { nodes: layout.nodes, edges: layout.edges } : null,
        };
      }),
    );

    return results;
  },
});

/**
 * Permanently delete a project and all its environments, agent configs, and canvas layouts.
 * @param projectId The project to delete
 * @throws Error if user is not authenticated or does not own the project
 */
export const deleteById = mutation({
  args: {
    projectId: v.id("projects"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifyProjectOwnership(ctx, projectId, user.subject);

    // Delete all agentConfigs for this project
    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    for (const config of configs) {
      await ctx.db.delete(config._id);
    }

    // Delete all canvasLayouts for this project
    const layouts = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    for (const layout of layouts) {
      await ctx.db.delete(layout._id);
    }

    // Delete all environments for this project
    const environments = await ctx.db
      .query("environments")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    for (const env of environments) {
      await ctx.db.delete(env._id);
    }

    await ctx.db.delete(projectId);

    return null;
  },
});
