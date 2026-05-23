/**
 * Temporary canvas layout API backed by the canvasLayouts table.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";

const canvasNodeValidator = v.object({
    id: v.string(),
    type: v.union(
        v.literal("agent"),
        v.literal("database"),
        v.literal("workspace"),
        v.literal("tool"),
    ),
    position: v.object({ x: v.number(), y: v.number() }),
    data: v.any(),
});

const canvasEdgeValidator = v.object({
    id: v.string(),
    source: v.string(),
    target: v.string(),
    animated: v.optional(v.boolean()),
});

/**
 * Loads the saved canvas layout for a project environment.
 * @param projectId Parent project id
 * @param environmentId Target environment id
 * @returns Canvas nodes and edges, or null when none saved yet
 */
export const getByProject = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
    },
    returns: v.union(
        v.null(),
        v.object({
            nodes: v.array(canvasNodeValidator),
            edges: v.array(canvasEdgeValidator),
        }),
    ),
    handler: async (ctx, args) => {
        const { projectId, environmentId } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) {
            throw new Error("Project not found.");
        }

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const layout = await ctx.db
            .query("canvasLayouts")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .unique();

        if (!layout) {
            return null;
        }

        return {
            nodes: layout.nodes,
            edges: layout.edges,
        };
    },
});

/**
 * Persists the current canvas layout for a project environment.
 * @param projectId Parent project id
 * @param environmentId Target environment id
 * @param nodes React Flow nodes to save
 * @param edges React Flow edges to save
 * @returns Saved canvas layout document id
 */
export const saveLayout = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodes: v.array(canvasNodeValidator),
        edges: v.array(canvasEdgeValidator),
    },
    returns: v.id("canvasLayouts"),
    handler: async (ctx, args) => {
        const { projectId, environmentId, nodes, edges } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) {
            throw new Error("Project not found.");
        }

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const now = Date.now();
        const existing = await ctx.db
            .query("canvasLayouts")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .unique();

        if (existing) {
            await ctx.db.patch(existing._id, {
                nodes: nodes,
                edges: edges,
                updatedAt: now,
            });

            return existing._id;
        }

        return await ctx.db.insert("canvasLayouts", {
            authId: authUser.id,
            projectId: projectId,
            environmentId: environmentId,
            nodes: nodes,
            edges: edges,
            updatedAt: now,
        });
    },
});
