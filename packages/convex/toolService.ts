/**
 * Dashboard-facing API for custom tools, backed by the same `accountTools` rows
 * the CLI syncs and the runtime executes. A tool authored on the canvas is a
 * real tool: its source is bundled to S3 on save, so an agent can call it.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { authKit } from "./auth";
import { putToolBundle } from "./model/bundles";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";
import { accountToolsFields } from "./schema";

const MAX_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_INPUT_BYTES = 256 * 1024;
const MAX_TOOL_SOURCE_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

const toolDoc = v.object({
  ...accountToolsFields,
  _id: v.id("accountTools"),
  _creationTime: v.number(),
});

/** The tool a canvas node owns, or null when the node has never been saved. */
export const getByNode = query({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
  },
  returns: v.union(v.null(), toolDoc),
  handler: async (ctx, { projectId, environmentId, nodeId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Resolve ownership without throwing: a deleted project/environment should
    // yield null for this reactive query rather than crashing the canvas.
    const project = await getOwnedProject(ctx, authUser.id, projectId);
    if (!project) return null;
    const environment = await getOwnedEnvironment(
      ctx,
      authUser.id,
      environmentId,
    );
    if (!environment || environment.projectId !== projectId) return null;

    const tool = await ctx.db
      .query("accountTools")
      .withIndex("by_environmentId_and_nodeId", (q) =>
        q.eq("environmentId", environmentId).eq("nodeId", nodeId),
      )
      .first();

    return tool?.status === "active" ? tool : null;
  },
});

/** Every tool in an environment, CLI-synced and dashboard-authored alike. */
export const listForEnvironment = query({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
  },
  returns: v.array(toolDoc),
  handler: async (ctx, { projectId, environmentId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getOwnedProject(ctx, authUser.id, projectId);
    if (!project) return [];
    const environment = await getOwnedEnvironment(
      ctx,
      authUser.id,
      environmentId,
    );
    if (!environment || environment.projectId !== projectId) return [];

    return await ctx.db
      .query("accountTools")
      .withIndex("by_environmentId_and_status", (q) =>
        q.eq("environmentId", environmentId).eq("status", "active"),
      )
      .collect();
  },
});

/**
 * Save a canvas-authored tool. An action, not a mutation: the source has to
 * reach S3 as a bundle before the row can point at it, otherwise the tool would
 * exist in config but fail the moment an agent called it.
 */
export const saveForNode = action({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
    nodeLabel: v.string(),
    sourceCode: v.optional(v.string()),
    description: v.optional(v.string()),
    inputSchema: v.optional(v.any()),
    runtime: v.optional(v.union(v.literal("isolate"), v.literal("sandbox"))),
    disabled: v.optional(v.boolean()),
  },
  returns: v.id("accountTools"),
  handler: async (ctx, args): Promise<Id<"accountTools">> => {
    if (
      args.sourceCode &&
      new TextEncoder().encode(args.sourceCode).byteLength >
        MAX_TOOL_SOURCE_BYTES
    ) {
      throw new Error(
        `Tool source code must be ${MAX_TOOL_SOURCE_BYTES} bytes or smaller.`,
      );
    }

    const context = await ctx.runQuery(internal.toolService.nodeContext, {
      projectId: args.projectId,
      environmentId: args.environmentId,
      nodeId: args.nodeId,
    });

    // A first save with no source would bundle the empty string, so the tool
    // would exist in config and fail the moment an agent called it.
    const sourceCode = args.sourceCode ?? context.existing?.sourceCode ?? "";
    if (!sourceCode.trim()) {
      throw new Error("Write the tool source before saving it.");
    }
    // Only re-upload when the source actually changed; the key is the digest.
    const sha256 = await digest(sourceCode);
    const bundleStorageKey =
      context.existing && context.existing.sha256 === sha256
        ? context.existing.bundleStorageKey
        : await putToolBundle(ctx, {
            accountId: context.accountId,
            sha256: sha256,
            bundle: sourceCode,
          });

    return await ctx.runMutation(internal.toolService.upsertForNode, {
      accountId: context.accountId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      nodeId: args.nodeId,
      name: args.nodeLabel,
      sourceCode: sourceCode,
      sha256: sha256,
      bundleStorageKey: bundleStorageKey,
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
      ...(args.inputSchema !== undefined
        ? { inputSchema: args.inputSchema }
        : {}),
      ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
      ...(args.disabled !== undefined ? { disabled: args.disabled } : {}),
    });
  },
});

/**
 * Run a tool's source against the executor so the canvas can test it without a
 * full agent run. Reads the same row the runtime executes, so what passes here
 * is what the agent calls.
 */
export const execute = action({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
    input: v.optional(v.any()),
    timeoutMs: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (
    ctx,
    { projectId, environmentId, nodeId, input, timeoutMs },
  ) => {
    const tool = await ctx.runQuery(api.toolService.getByNode, {
      projectId: projectId,
      environmentId: environmentId,
      nodeId: nodeId,
    });
    if (!tool) throw new Error("Tool configuration not found.");
    if (tool.disabled === true) throw new Error("Tool is disabled.");

    const normalizedInput = input ?? {};
    const inputBytes = new TextEncoder().encode(
      JSON.stringify(normalizedInput),
    ).byteLength;
    if (inputBytes > MAX_TOOL_INPUT_BYTES) {
      throw new Error(
        `Tool input must be ${MAX_TOOL_INPUT_BYTES} bytes or smaller.`,
      );
    }
    const boundedTimeoutMs = Math.min(
      Math.max(Math.trunc(timeoutMs ?? MAX_TOOL_TIMEOUT_MS), 1_000),
      MAX_TOOL_TIMEOUT_MS,
    );
    const url =
      process.env.CUSTOM_TOOL_EXECUTOR_URL?.trim().replace(/\/+$/, "") ?? "";
    const secret = process.env.CUSTOM_TOOL_EXECUTOR_SECRET?.trim() ?? "";
    const secretHeader =
      process.env.CUSTOM_TOOL_EXECUTOR_SECRET_HEADER?.trim() ||
      "X-Executor-Secret";
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
        language: "javascript",
        sourceCode: tool.sourceCode ?? "",
        input: normalizedInput,
        timeoutMs: boundedTimeoutMs,
      }),
    });

    const rawBody = await upstream.text().catch(() => "");
    if (new TextEncoder().encode(rawBody).byteLength > MAX_TOOL_OUTPUT_BYTES) {
      throw new Error(
        `Tool output must be ${MAX_TOOL_OUTPUT_BYTES} bytes or smaller.`,
      );
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

/** Ownership check plus the account and existing row `saveForNode` needs. */
export const nodeContext = internalQuery({
  args: {
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
  },
  returns: v.object({
    accountId: v.id("accounts"),
    existing: v.union(v.null(), toolDoc),
  }),
  handler: async (ctx, { projectId, environmentId, nodeId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getOwnedProject(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");
    const environment = await getOwnedEnvironment(
      ctx,
      authUser.id,
      environmentId,
    );
    if (!environment || environment.projectId !== projectId) {
      throw new Error("Environment not found.");
    }
    if (!project.orgId) throw new Error("Project is not linked to an org");
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId as string))
      .first();
    if (!account) throw new Error("Account not found for project org");

    const existing = await ctx.db
      .query("accountTools")
      .withIndex("by_environmentId_and_nodeId", (q) =>
        q.eq("environmentId", environmentId).eq("nodeId", nodeId),
      )
      .first();

    return { accountId: account._id, existing: existing };
  },
});

export const upsertForNode = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    nodeId: v.string(),
    name: v.string(),
    sourceCode: v.string(),
    sha256: v.string(),
    bundleStorageKey: v.string(),
    description: v.optional(v.string()),
    inputSchema: v.optional(v.any()),
    runtime: v.optional(v.union(v.literal("isolate"), v.literal("sandbox"))),
    disabled: v.optional(v.boolean()),
  },
  returns: v.id("accountTools"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("accountTools")
      .withIndex("by_environmentId_and_nodeId", (q) =>
        q.eq("environmentId", args.environmentId).eq("nodeId", args.nodeId),
      )
      .first();

    if (existing) {
      // Carry the scope and revive the row: a legacy or tombstoned match is
      // still this node's tool, and the index holds only one row per node.
      await ctx.db.patch(existing._id, {
        projectId: args.projectId,
        status: "active",
        deletedAt: undefined,
        name: toolName(args.name) || existing.name,
        sourceCode: args.sourceCode,
        sha256: args.sha256,
        bundleStorageKey: args.bundleStorageKey,
        ...(args.description !== undefined
          ? { description: args.description }
          : {}),
        ...(args.inputSchema !== undefined
          ? { inputSchema: args.inputSchema }
          : {}),
        ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
        ...(args.disabled !== undefined ? { disabled: args.disabled } : {}),
        updatedAt: now,
      });

      return existing._id;
    }

    return await ctx.db.insert("accountTools", {
      accountId: args.accountId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      nodeId: args.nodeId,
      name: toolName(args.name) || "tool",
      description: args.description ?? "",
      inputSchema: args.inputSchema ?? {
        type: "object",
        properties: {},
      },
      bundleStorageKey: args.bundleStorageKey,
      sha256: args.sha256,
      sourceCode: args.sourceCode,
      runtime: args.runtime ?? "isolate",
      disabled: args.disabled,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Remove a canvas-authored tool when its node is deleted. */
export const removeForNode = internalMutation({
  args: {
    environmentId: v.id("environments"),
    nodeId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { environmentId, nodeId }) => {
    const existing = await ctx.db
      .query("accountTools")
      .withIndex("by_environmentId_and_nodeId", (q) =>
        q.eq("environmentId", environmentId).eq("nodeId", nodeId),
      )
      .first();
    if (existing) await ctx.db.delete(existing._id);

    return null;
  },
});

async function digest(source: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );

  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The model calls a tool by name, so a canvas label has to become an identifier. */
function toolName(label: string): string {
  return label
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
