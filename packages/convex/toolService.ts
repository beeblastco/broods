/**
 * Temporary tool service persistence and execution proxy for the canvas UI.
 */
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { toolServicesFields } from "./schema";

const toolServiceDoc = v.object({
    ...toolServicesFields,
    _id: v.id("toolServices"),
    _creationTime: v.number(),
});

/**
 * Loads a tool service configuration for a canvas node.
 * @param projectId Parent project id
 * @param environmentId Environment id
 * @param nodeId Canvas node id
 * @returns Tool service document or null when not configured
 */
export const getByNode = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodeId: v.string(),
    },
    returns: v.union(v.null(), toolServiceDoc),
    handler: async (ctx, args) => {
        const { projectId, environmentId, nodeId } = args;

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

        return await ctx.db
            .query("toolServices")
            .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
                q
                    .eq("projectId", projectId)
                    .eq("environmentId", environmentId)
                    .eq("nodeId", nodeId),
            )
            .first();
    },
});

/**
 * Creates or updates a tool service for a canvas node.
 * @param projectId Parent project id
 * @param environmentId Environment id
 * @param nodeId Canvas node id
 * @param nodeLabel Tool display label
 * @returns Tool service document id
 */
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
    handler: async (ctx, args) => {
        const { projectId, environmentId, nodeId, nodeLabel, sourceCode, language, status } =
            args;

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
            .query("toolServices")
            .withIndex("by_projectId_environmentId_and_nodeId", (q) =>
                q
                    .eq("projectId", projectId)
                    .eq("environmentId", environmentId)
                    .eq("nodeId", nodeId),
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

        return await ctx.db.insert("toolServices", {
            authId: authUser.id,
            projectId: projectId,
            environmentId: environmentId,
            nodeId: nodeId,
            nodeLabel: nodeLabel.trim() || "Tool",
            language: language ?? "javascript",
            sourceCode: sourceCode ?? "",
            status: status ?? "enabled",
            updatedAt: now,
        });
    },
});

/**
 * Executes tool source code via the configured custom tool executor.
 * @param language Tool runtime language
 * @param sourceCode Tool handler source
 * @param input JSON input payload
 * @returns Executor response body
 */
export const execute = action({
    args: {
        language: v.union(v.literal("javascript"), v.literal("python")),
        sourceCode: v.string(),
        input: v.optional(v.any()),
        timeoutMs: v.optional(v.number()),
    },
    returns: v.any(),
    handler: async (_ctx, args) => {
        const { language, sourceCode, input, timeoutMs } = args;

        const url = process.env.CUSTOM_TOOL_EXECUTOR_URL?.trim().replace(/\/+$/, "") ?? "";
        const secret = process.env.CUSTOM_TOOL_EXECUTOR_SECRET?.trim() ?? "";
        const secretHeaderName =
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
                [secretHeaderName]: secret,
            },
            body: JSON.stringify({
                language: language,
                sourceCode: sourceCode,
                input: input ?? {},
                timeoutMs: timeoutMs,
            }),
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
