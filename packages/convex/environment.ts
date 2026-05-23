/**
 * Public environment queries and mutations scoped to a project owner.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { environmentsFields } from "./schema";

const environmentDoc = v.object({
    ...environmentsFields,
    _id: v.id("environments"),
    _creationTime: v.number(),
});

/**
 * Lists environments for a project owned by the authenticated user.
 * @param projectId Parent project document id
 * @returns Environment documents for the project
 */
export const list = query({
    args: {
        projectId: v.id("projects"),
    },
    returns: v.array(environmentDoc),
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

        return environments.sort((left, right) => {
            if (left.isDefault !== right.isDefault) {
                return left.isDefault ? -1 : 1;
            }

            return left.name.localeCompare(right.name);
        });
    },
});

/**
 * Ensures a default Production environment exists for the project.
 * @param projectId Parent project document id
 * @returns Default environment document id
 */
export const ensureDefault = mutation({
    args: {
        projectId: v.id("projects"),
    },
    returns: v.id("environments"),
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

        const existingDefault = environments.find((environment) => environment.isDefault);
        if (existingDefault) {
            return existingDefault._id;
        }

        const now = Date.now();
        const environmentId = await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId: projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        await ctx.db.patch(projectId, { updatedAt: now });

        return environmentId;
    },
});

/**
 * Creates a new environment within an owned project.
 * @param projectId Parent project document id
 * @param name Environment display name
 * @param duplicateFromId Optional source environment id (reserved for future duplication)
 * @returns New environment document id
 */
export const create = mutation({
    args: {
        projectId: v.id("projects"),
        name: v.string(),
        duplicateFromId: v.optional(v.id("environments")),
    },
    returns: v.id("environments"),
    handler: async (ctx, args) => {
        const { projectId, name, duplicateFromId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) {
            throw new Error("Project not found.");
        }

        if (duplicateFromId) {
            const sourceEnvironment = await getOwnedEnvironment(
                ctx,
                authUser.id,
                duplicateFromId,
            );
            if (!sourceEnvironment || sourceEnvironment.projectId !== projectId) {
                throw new Error("Source environment not found.");
            }
        }

        const trimmedName = name.trim();
        if (!trimmedName) {
            throw new Error("Environment name is required.");
        }

        const now = Date.now();
        const environmentId = await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId: projectId,
            name: trimmedName,
            isDefault: false,
            updatedAt: now,
        });

        await ctx.db.patch(projectId, { updatedAt: now });

        return environmentId;
    },
});

/**
 * Deletes a non-default environment from an owned project.
 * @param environmentId Environment document id
 * @returns Deleted environment document id
 */
export const remove = mutation({
    args: {
        environmentId: v.id("environments"),
    },
    returns: v.id("environments"),
    handler: async (ctx, args) => {
        const { environmentId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment) {
            throw new Error("Environment not found.");
        }

        if (environment.isDefault) {
            throw new Error("The default environment cannot be deleted.");
        }

        await ctx.db.delete(environmentId);
        await ctx.db.patch(environment.projectId, { updatedAt: Date.now() });

        return environmentId;
    },
});
