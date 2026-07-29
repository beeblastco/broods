/**
 * Internal custom tool metadata API consumed by core's Convex storage adapter.
 * Tools are scoped to one (projectId, environmentId); the runtime resolves them
 * by `_id`, so a per-environment row already yields a per-environment tool.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { resolveProjectEnvironment } from "./model/projectScope";
import { accountToolsFields } from "./schema";

const accountToolDoc = v.object({
  ...accountToolsFields,
  _id: v.id("accountTools"),
  _creationTime: v.number(),
});

const runtimeValidator = v.union(v.literal("isolate"), v.literal("sandbox"));

export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    toolId: v.string(),
  },
  returns: v.union(accountToolDoc, v.null()),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("accountTools", args.toolId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId || doc.status !== "active")
      return null;

    return doc;
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(accountToolDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("accountTools")
      .withIndex("by_accountId_and_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "active"),
      )
      .collect();
  },
});

/**
 * Resolve a project/environment slug pair the REST API was called with. Unlike
 * the CLI's `ensureScopeBySecretHash` this never creates: an unknown slug is a
 * client error, not a reason to spawn a project.
 */
export const resolveScope = internalQuery({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
    environment: v.string(),
  },
  returns: v.union(
    v.object({
      projectId: v.id("projects"),
      environmentId: v.id("environments"),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await resolveProjectEnvironment(
      ctx,
      args.accountId,
      args.project,
      args.environment,
    );
  },
});

export const listForEnvironment = internalQuery({
  args: { environmentId: v.id("environments") },
  returns: v.array(accountToolDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("accountTools")
      .withIndex("by_environmentId_and_status", (q) =>
        q.eq("environmentId", args.environmentId).eq("status", "active"),
      )
      .collect();
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    name: v.string(),
    description: v.string(),
    inputSchema: v.any(),
    bundleStorageKey: v.string(),
    sha256: v.string(),
    runtime: v.optional(runtimeValidator),
    defaultConfig: v.optional(v.any()),
    sourceCode: v.optional(v.string()),
  },
  returns: v.id("accountTools"),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.projectId !== args.projectId) {
      throw new Error(`Environment not found: ${args.environmentId}`);
    }

    const now = Date.now();

    return await ctx.db.insert("accountTools", {
      accountId: args.accountId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      name: args.name,
      description: args.description,
      inputSchema: args.inputSchema,
      bundleStorageKey: args.bundleStorageKey,
      sha256: args.sha256,
      runtime: args.runtime ?? "sandbox",
      defaultConfig: args.defaultConfig,
      sourceCode: args.sourceCode,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    toolId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    inputSchema: v.optional(v.any()),
    bundleStorageKey: v.optional(v.string()),
    sha256: v.optional(v.string()),
    runtime: v.optional(runtimeValidator),
    defaultConfig: v.optional(v.any()),
    sourceCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("accountTools", args.toolId);
    if (!normalized) {
      throw new Error("Tool does not belong to the supplied accountId");
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId || doc.status !== "active") {
      throw new Error("Tool does not belong to the supplied accountId");
    }

    await ctx.db.patch(normalized, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
      ...(args.inputSchema !== undefined
        ? { inputSchema: args.inputSchema }
        : {}),
      ...(args.bundleStorageKey !== undefined
        ? { bundleStorageKey: args.bundleStorageKey }
        : {}),
      ...(args.sha256 !== undefined ? { sha256: args.sha256 } : {}),
      ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
      ...(args.sourceCode !== undefined ? { sourceCode: args.sourceCode } : {}),
      ...(args.defaultConfig !== undefined
        ? {
            defaultConfig:
              args.defaultConfig === null ? undefined : args.defaultConfig,
          }
        : {}),
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    toolId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("accountTools", args.toolId);
    if (!normalized) {
      throw new Error("Tool does not belong to the supplied accountId");
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) {
      throw new Error("Tool does not belong to the supplied accountId");
    }

    await ctx.db.patch(normalized, {
      status: "deleted",
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return null;
  },
});
