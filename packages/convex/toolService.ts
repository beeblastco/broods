/**
 * Tool service persistence and execution proxy for canvas nodes.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { action, mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { toolServicesFields } from "./schema";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

const toolServiceDoc = v.object({
    ...toolServicesFields,
    _id: v.id("toolServices"),
    _creationTime: v.number(),
});

async function requireOwnedProjectEnv(
    ctx: Ctx,
    authId: string,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
) {
    const project = await getOwnedProject(ctx, authId, projectId);
    if (!project) throw new Error("Project not found.");
    const environment = await getOwnedEnvironment(ctx, authId, environmentId);
    if (!environment || environment.projectId !== projectId) {
        throw new Error("Environment not found.");
    }
}

export const getByNode = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodeId: v.string(),
    },
    returns: v.union(v.null(), toolServiceDoc),
    handler: async (ctx, { projectId, environmentId, nodeId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");
        await requireOwnedProjectEnv(ctx, authUser.id, projectId, environmentId);

        return ctx.db
            .query("toolServices")
            .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId).eq("nodeId", nodeId),
            )
            .first();
    },
});

export const upsertForNode = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodeId: v.string(),
        nodeLabel: v.string(),
        sourceCode: v.optional(v.string()),
        language: v.optional(v.union(v.literal("javascript"), v.literal("python"))),
        status: v.optional(v.union(v.literal("enabled"), v.literal("disabled"))),
    },
    returns: v.id("toolServices"),
    handler: async (ctx, { projectId, environmentId, nodeId, nodeLabel, sourceCode, language, status }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");
        await requireOwnedProjectEnv(ctx, authUser.id, projectId, environmentId);

        const now = Date.now();
        const existing = await ctx.db
            .query("toolServices")
            .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId).eq("nodeId", nodeId),
            )
            .first();

        if (existing) {
            await ctx.db.patch(existing._id, {
                nodeLabel: nodeLabel.trim() || existing.nodeLabel,
                sourceCode: sourceCode ?? existing.sourceCode,
                language: language ?? existing.language,
                status: status ?? existing.status,
                updatedAt: now,
            });
            return existing._id;
        }

        return ctx.db.insert("toolServices", {
            authId: authUser.id,
            projectId,
            environmentId,
            nodeId,
            nodeLabel: nodeLabel.trim() || "Tool",
            language: language ?? "javascript",
            sourceCode: sourceCode ?? "",
            status: status ?? "enabled",
            updatedAt: now,
        });
    },
});

export const execute = action({
    args: {
        language: v.union(v.literal("javascript"), v.literal("python")),
        sourceCode: v.string(),
        input: v.optional(v.any()),
        timeoutMs: v.optional(v.number()),
    },
    returns: v.any(),
    handler: async (_ctx, { language, sourceCode, input, timeoutMs }) => {
        const url = process.env.CUSTOM_TOOL_EXECUTOR_URL?.trim().replace(/\/+$/, "") ?? "";
        const secret = process.env.CUSTOM_TOOL_EXECUTOR_SECRET?.trim() ?? "";
        const secretHeader =
            process.env.CUSTOM_TOOL_EXECUTOR_SECRET_HEADER?.trim() || "X-Executor-Secret";

        if (!url || !secret) {
            throw new Error(
                "CUSTOM_TOOL_EXECUTOR_URL and CUSTOM_TOOL_EXECUTOR_SECRET must be configured.",
            );
        }

        const upstream = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                [secretHeader]: secret,
            },
            body: JSON.stringify({ language, sourceCode, input: input ?? {}, timeoutMs }),
        });

        const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
        if (!upstream.ok) {
            throw new Error(
                typeof body.error === "string"
                    ? body.error
                    : `Executor request failed with status ${upstream.status}.`,
            );
        }

        return body;
    },
});
