/**
 * Public project queries and mutations scoped to the authenticated user.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { uniqueProjectSlug } from "./lib/slug";
import { getOwnedProject } from "./model/ownership/project";
import { projectsFields } from "./schema";

const projectDoc = v.object({
    ...projectsFields,
    _id: v.id("projects"),
    _creationTime: v.number(),
});

/**
 * Returns the user's default workspace project, creating one when missing.
 * @returns Default project document id
 */
export const getOrCreateDefault = mutation({
    args: {},
    returns: v.id("projects"),
    handler: async (ctx) => {
        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const projects = await ctx.db
            .query("projects")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .collect();

        const existingProject = projects.sort((left, right) => right.updatedAt - left.updatedAt)[0];
        if (existingProject) {
            return existingProject._id;
        }

        const now = Date.now();
        const slug = await uniqueProjectSlug(ctx, authUser.id, "Workspace");
        const projectId = await ctx.db.insert("projects", {
            authId: authUser.id,
            name: "Workspace",
            description: undefined,
            slug: slug,
            updatedAt: now,
        });

        await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId: projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        return projectId;
    },
});

/**
 * Lists all projects owned by the authenticated user.
 * @returns Project documents ordered by most recently updated
 */
export const list = query({
    args: {},
    returns: v.array(projectDoc),
    handler: async (ctx) => {
        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const projects = await ctx.db
            .query("projects")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .collect();

        return projects.sort((left, right) => right.updatedAt - left.updatedAt);
    },
});

/**
 * Lists projects with dashboard preview fields for the home page.
 * @returns Projects with placeholder preview metadata
 */
export const listWithPreview = query({
    args: {},
    returns: v.array(v.object({
        _id: v.id("projects"),
        name: v.string(),
        canvas: v.null(),
        deployedAgentCount: v.number(),
    })),
    handler: async (ctx) => {
        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const projects = await ctx.db
            .query("projects")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .collect();

        const sortedProjects = projects.sort((left, right) => right.updatedAt - left.updatedAt);

        return sortedProjects.map((project) => ({
            _id: project._id,
            name: project.name,
            canvas: null,
            deployedAgentCount: 0,
        }));
    },
});

/**
 * Loads a single project by id for the authenticated owner.
 * @param projectId Project document id
 * @returns Project document or null when not found
 */
export const getById = query({
    args: {
        projectId: v.id("projects"),
    },
    returns: v.union(v.null(), projectDoc),
    handler: async (ctx, args) => {
        const { projectId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        return await getOwnedProject(ctx, authUser.id, projectId);
    },
});

/**
 * Creates a project and its default Production environment.
 * @param name Display name for the project
 * @param description Optional project description
 * @returns New project document id
 */
export const create = mutation({
    args: {
        name: v.string(),
        description: v.optional(v.string()),
    },
    returns: v.id("projects"),
    handler: async (ctx, args) => {
        const { name, description } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const trimmedName = name.trim();
        if (!trimmedName) {
            throw new Error("Project name is required.");
        }

        const now = Date.now();
        const slug = await uniqueProjectSlug(ctx, authUser.id, trimmedName);

        const projectId = await ctx.db.insert("projects", {
            authId: authUser.id,
            name: trimmedName,
            description: description?.trim() || undefined,
            slug: slug,
            updatedAt: now,
        });

        await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId: projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        return projectId;
    },
});

/**
 * Updates editable project fields for the authenticated owner.
 * @param projectId Project document id
 * @param name Updated display name
 * @param description Updated description, or undefined to clear
 * @returns Updated project document id
 */
export const update = mutation({
    args: {
        projectId: v.id("projects"),
        name: v.string(),
        description: v.optional(v.string()),
    },
    returns: v.id("projects"),
    handler: async (ctx, args) => {
        const { projectId, name, description } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) {
            throw new Error("Project not found.");
        }

        const trimmedName = name.trim();
        if (!trimmedName) {
            throw new Error("Project name is required.");
        }

        const slug =
            trimmedName === project.name
                ? project.slug
                : await uniqueProjectSlug(ctx, authUser.id, trimmedName);

        await ctx.db.patch(projectId, {
            name: trimmedName,
            description: description?.trim() || undefined,
            slug: slug,
            updatedAt: Date.now(),
        });

        return projectId;
    },
});

/**
 * Permanently deletes a project and all of its environments.
 * @param projectId Project document id
 * @returns Deleted project document id
 */
export const remove = mutation({
    args: {
        projectId: v.id("projects"),
    },
    returns: v.id("projects"),
    handler: async (ctx, args) => {
        const { projectId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) {
            throw new Error("Project not found.");
        }

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        for (const environment of environments) {
            await ctx.db.delete(environment._id);
        }

        await ctx.db.delete(projectId);

        return projectId;
    },
});
