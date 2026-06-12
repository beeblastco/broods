/**
 * Tool service persistence and execution proxy for canvas nodes.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { action, mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { toolServicesFields } from "./schema";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

const MAX_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_INPUT_BYTES = 256 * 1024;
const MAX_TOOL_SOURCE_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

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

        // Resolve ownership without throwing: a deleted project/environment should
        // yield null for this reactive query rather than crashing the canvas.
        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) return null;
        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return null;

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

        if (sourceCode && new TextEncoder().encode(sourceCode).byteLength > MAX_TOOL_SOURCE_BYTES) {
            throw new Error(`Tool source code must be ${MAX_TOOL_SOURCE_BYTES} bytes or smaller.`);
        }

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
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodeId: v.string(),
        input: v.optional(v.any()),
        timeoutMs: v.optional(v.number()),
    },
    returns: v.any(),
    handler: async (ctx, { projectId, environmentId, nodeId, input, timeoutMs }) => {
        const tool = await ctx.runQuery(api.toolService.getByNode, {
            projectId: projectId,
            environmentId: environmentId,
            nodeId: nodeId,
        });
        if (!tool) {
            throw new Error("Tool configuration not found.");
        }
        if (tool.status !== "enabled") {
            throw new Error("Tool is disabled.");
        }

        const normalizedInput = input ?? {};
        const inputBytes = new TextEncoder().encode(JSON.stringify(normalizedInput)).byteLength;
        if (inputBytes > MAX_TOOL_INPUT_BYTES) {
            throw new Error(`Tool input must be ${MAX_TOOL_INPUT_BYTES} bytes or smaller.`);
        }
        const boundedTimeoutMs = Math.min(
            Math.max(Math.trunc(timeoutMs ?? MAX_TOOL_TIMEOUT_MS), 1_000),
            MAX_TOOL_TIMEOUT_MS,
        );
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
            body: JSON.stringify({
                language: tool.language,
                sourceCode: tool.sourceCode,
                input: normalizedInput,
                timeoutMs: boundedTimeoutMs,
            }),
        });

        const rawBody = await upstream.text().catch(() => "");
        if (new TextEncoder().encode(rawBody).byteLength > MAX_TOOL_OUTPUT_BYTES) {
            throw new Error(`Tool output must be ${MAX_TOOL_OUTPUT_BYTES} bytes or smaller.`);
        }
        let body: Record<string, unknown> = {};
        try {
            body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
            // Non-JSON executor responses fall through to the status check below.
        }
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
