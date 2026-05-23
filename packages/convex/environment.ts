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

export const list = query({
    args: { projectId: v.id("projects") },
    returns: v.array(environmentDoc),
    handler: async (ctx, { projectId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        return environments.sort((a, b) =>
            a.isDefault !== b.isDefault
                ? (a.isDefault ? -1 : 1)
                : a.name.localeCompare(b.name),
        );
    },
});

export const ensureDefault = mutation({
    args: { projectId: v.id("projects") },
    returns: v.id("environments"),
    handler: async (ctx, { projectId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const existing = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        const existingDefault = existing.find((e) => e.isDefault);
        if (existingDefault) return existingDefault._id;

        const now = Date.now();
        const environmentId = await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        await ctx.db.patch(projectId, { updatedAt: now });
        return environmentId;
    },
});

export const create = mutation({
    args: {
        projectId: v.id("projects"),
        name: v.string(),
        duplicateFromId: v.optional(v.id("environments")),
    },
    returns: v.id("environments"),
    handler: async (ctx, { projectId, name, duplicateFromId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        if (duplicateFromId) {
            const source = await getOwnedEnvironment(ctx, authUser.id, duplicateFromId);
            if (!source || source.projectId !== projectId) {
                throw new Error("Source environment not found.");
            }
        }

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Environment name is required.");

        const now = Date.now();
        const environmentId = await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: trimmedName,
            isDefault: false,
            updatedAt: now,
        });

        await ctx.db.patch(projectId, { updatedAt: now });
        return environmentId;
    },
});

export const remove = mutation({
    args: { environmentId: v.id("environments") },
    returns: v.id("environments"),
    handler: async (ctx, { environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment) throw new Error("Environment not found.");
        if (environment.isDefault) throw new Error("The default environment cannot be deleted.");

        await ctx.db.delete(environmentId);
        await ctx.db.patch(environment.projectId, { updatedAt: Date.now() });
        return environmentId;
    },
});
