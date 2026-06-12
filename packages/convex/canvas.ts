/**
 * Canvas layout persistence keyed by (project, environment).
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";

const canvasNodeValidator = v.object({
    id: v.string(),
    type: v.union(
        v.literal("agent"),
        v.literal("database"),
        v.literal("sandbox"),
        v.literal("workspace"),
        v.literal("tool"),
        v.literal("skill"),
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

const saveLayoutResult = v.object({
    layoutId: v.id("canvasLayouts"),
    nodes: v.array(canvasNodeValidator),
    edges: v.array(canvasEdgeValidator),
});

type CanvasNode = {
    id: string;
    type: "agent" | "database" | "sandbox" | "workspace" | "tool" | "skill";
    position: { x: number; y: number };
    data: unknown;
};

/** Coerce an unknown canvas node data payload into a mutable record. */
function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

/** Return the org account backing a project, if it has been provisioned. */
async function accountForProject(
    ctx: MutationCtx,
    project: Doc<"projects">,
): Promise<Doc<"accounts"> | null> {
    if (!project.orgId) return null;

    return await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
        .unique();
}

/** Ensure canvas runtime-resource nodes point at real core resource rows. */
async function materializeRuntimeNodes(
    ctx: MutationCtx,
    account: Doc<"accounts"> | null,
    nodes: CanvasNode[],
): Promise<CanvasNode[]> {
    if (!account) return nodes;

    const result: CanvasNode[] = [];
    for (const node of nodes) {
        if (node.type !== "workspace" && node.type !== "sandbox") {
            result.push(node);
            continue;
        }

        const data = asRecord(node.data);
        const resourceId = typeof data.resourceId === "string" ? data.resourceId.trim() : "";
        const table = node.type === "workspace" ? "workspaceConfigs" : "sandboxConfigs";
        const normalized = resourceId ? ctx.db.normalizeId(table, resourceId) : null;
        if (normalized) {
            const existing = await ctx.db.get(normalized as Id<typeof table>);
            if (existing && existing.accountId === account._id) {
                result.push(node);
                continue;
            }
        }

        const name = String(data.mountName ?? data.label ?? node.type).trim() || node.type;
        const now = Date.now();
        const createdId = node.type === "workspace"
            ? await ctx.db.insert("workspaceConfigs", {
                accountId: account._id,
                name: name,
                description: typeof data.description === "string" ? data.description : undefined,
                config: asRecord(data.config).storage ? data.config : { storage: { provider: "s3" } },
                createdAt: now,
                updatedAt: now,
            })
            : await ctx.db.insert("sandboxConfigs", {
                accountId: account._id,
                name: name,
                description: typeof data.description === "string" ? data.description : undefined,
                createdAt: now,
                updatedAt: now,
            });

        result.push({
            ...node,
            data: {
                ...data,
                resourceId: createdId,
            },
        });
    }

    return result;
}

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
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        // Reactive subscribers may briefly hold a just-deleted project/environment;
        // return null instead of throwing so the canvas unmounts without crashing.
        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) return null;

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return null;

        const layout = await ctx.db
            .query("canvasLayouts")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .unique();

        return layout ? { nodes: layout.nodes, edges: layout.edges } : null;
    },
});

export const saveLayout = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodes: v.array(canvasNodeValidator),
        edges: v.array(canvasEdgeValidator),
    },
    returns: saveLayoutResult,
    handler: async (ctx, { projectId, environmentId, nodes, edges }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const now = Date.now();
        const account = await accountForProject(ctx, project);
        const persistedNodes = await materializeRuntimeNodes(ctx, account, nodes);
        const existing = await ctx.db
            .query("canvasLayouts")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .unique();

        if (existing) {
            await ctx.db.patch(existing._id, { nodes: persistedNodes, edges, updatedAt: now });

            return { layoutId: existing._id, nodes: persistedNodes, edges: edges };
        }

        const layoutId = await ctx.db.insert("canvasLayouts", {
            authId: authUser.id,
            projectId,
            environmentId,
            nodes: persistedNodes,
            edges,
            updatedAt: now,
        });

        return { layoutId: layoutId, nodes: persistedNodes, edges: edges };
    },
});
