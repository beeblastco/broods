/**
 * Public project queries and mutations scoped to the authenticated user.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { uniqueProjectSlug } from "./lib/slug";
import { getOwnedProject } from "./model/ownership/project";
import { projectsFields } from "./schema";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

const projectDoc = v.object({
    ...projectsFields,
    _id: v.id("projects"),
    _creationTime: v.number(),
});

async function requireAuth(ctx: Ctx) {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");
    return authUser;
}

async function listProjects(ctx: Ctx, authId: string) {
    const projects = await ctx.db
        .query("projects")
        .withIndex("by_authId", (q) => q.eq("authId", authId))
        .collect();
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getOrCreateDefault = mutation({
    args: {},
    returns: v.id("projects"),
    handler: async (ctx) => {
        const authUser = await requireAuth(ctx);

        const existing = (await listProjects(ctx, authUser.id))[0];
        if (existing) return existing._id;

        const now = Date.now();
        const projectId = await ctx.db.insert("projects", {
            authId: authUser.id,
            name: "Workspace",
            description: undefined,
            slug: await uniqueProjectSlug(ctx, authUser.id, "Workspace"),
            updatedAt: now,
        });

        await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        return projectId;
    },
});

export const list = query({
    args: {},
    returns: v.array(projectDoc),
    handler: async (ctx) => {
        const authUser = await requireAuth(ctx);
        return listProjects(ctx, authUser.id);
    },
});

export const listWithPreview = query({
    args: {},
    returns: v.array(v.object({
        _id: v.id("projects"),
        name: v.string(),
        canvas: v.null(),
        deployedAgentCount: v.number(),
    })),
    handler: async (ctx) => {
        const authUser = await requireAuth(ctx);
        const projects = await listProjects(ctx, authUser.id);
        return projects.map((p) => ({
            _id: p._id,
            name: p.name,
            canvas: null,
            deployedAgentCount: 0,
        }));
    },
});

export const getById = query({
    args: { projectId: v.id("projects") },
    returns: v.union(v.null(), projectDoc),
    handler: async (ctx, { projectId }) => {
        const authUser = await requireAuth(ctx);
        return getOwnedProject(ctx, authUser.id, projectId);
    },
});

export const create = mutation({
    args: {
        name: v.string(),
        description: v.optional(v.string()),
    },
    returns: v.id("projects"),
    handler: async (ctx, { name, description }) => {
        const authUser = await requireAuth(ctx);

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project name is required.");

        const now = Date.now();
        const projectId = await ctx.db.insert("projects", {
            authId: authUser.id,
            name: trimmedName,
            description: description?.trim() || undefined,
            slug: await uniqueProjectSlug(ctx, authUser.id, trimmedName),
            updatedAt: now,
        });

        await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: "Production",
            isDefault: true,
            updatedAt: now,
        });

        return projectId;
    },
});

export const update = mutation({
    args: {
        projectId: v.id("projects"),
        name: v.string(),
        description: v.optional(v.string()),
    },
    returns: v.id("projects"),
    handler: async (ctx, { projectId, name, description }) => {
        const authUser = await requireAuth(ctx);

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project name is required.");

        const slug =
            trimmedName === project.name
                ? project.slug
                : await uniqueProjectSlug(ctx, authUser.id, trimmedName);

        await ctx.db.patch(projectId, {
            name: trimmedName,
            description: description?.trim() || undefined,
            slug,
            updatedAt: Date.now(),
        });

        return projectId;
    },
});

export const remove = mutation({
    args: { projectId: v.id("projects") },
    returns: v.id("projects"),
    handler: async (ctx, { projectId }) => {
        const authUser = await requireAuth(ctx);

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        for (const env of environments) {
            await ctx.db.delete(env._id);
        }

        await ctx.db.delete(projectId);

        return projectId;
    },
});
