/**
 * Internal custom tool metadata API consumed by core's Convex storage adapter.
 * Tools are scoped to one (projectId, stageId); the runtime resolves them
 * by `_id`, so a per-stage row already yields a per-stage tool.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { resolveProjectStage } from "./model/projectScope";
import { accountToolsFields } from "./schema";

const accountToolDoc = v.object({
  ...accountToolsFields,
  _id: v.id("accountTools"),
  _creationTime: v.number(),
});

const runtimeValidator = v.union(
  v.literal("isolate"),
  v.literal("sandbox"),
  v.literal("http"),
);

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

// Unlike the CLI's `ensureScopeBySecretHash` this never creates: an unknown
// slug is a client error, not a reason to spawn a project.
export const resolveScope = internalQuery({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
    stage: v.string(),
  },
  returns: v.union(
    v.object({
      projectId: v.id("projects"),
      stageId: v.id("stages"),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const resolved = await resolveProjectStage(
      ctx,
      account,
      args.project,
      args.stage,
    );
    if (!resolved) return null;

    return {
      projectId: resolved.projectDoc._id,
      stageId: resolved.stageDoc._id,
    };
  },
});

export const listForStage = internalQuery({
  args: { stageId: v.id("stages") },
  returns: v.array(accountToolDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("accountTools")
      .withIndex("by_stageId_and_status", (q) =>
        q.eq("stageId", args.stageId).eq("status", "active"),
      )
      .collect();
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
    description: v.string(),
    inputSchema: v.any(),
    // Absent for `runtime: "http"` tools, which carry an endpoint instead.
    bundleStorageKey: v.optional(v.string()),
    sha256: v.optional(v.string()),
    runtime: v.optional(runtimeValidator),
    endpointUrl: v.optional(v.string()),
    endpointHeaders: v.optional(v.record(v.string(), v.string())),
    defaultConfig: v.optional(v.any()),
    sourceCode: v.optional(v.string()),
  },
  returns: v.id("accountTools"),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }
    // Every caller derives the scope from the same secret, but the project's
    // org is what actually ties a tool to this account. Check it here.
    const project = await ctx.db.get(args.projectId);
    if (
      !project ||
      project.orgId !== ctx.db.normalizeId("orgs", account.orgId)
    ) {
      throw new Error(`Project not found: ${args.projectId}`);
    }
    const stage = await ctx.db.get(args.stageId);
    if (!stage || stage.projectId !== args.projectId) {
      throw new Error(`Stage not found: ${args.stageId}`);
    }

    const now = Date.now();

    return await ctx.db.insert("accountTools", {
      accountId: args.accountId,
      projectId: args.projectId,
      stageId: args.stageId,
      name: args.name,
      description: args.description,
      inputSchema: args.inputSchema,
      ...(args.bundleStorageKey !== undefined
        ? { bundleStorageKey: args.bundleStorageKey }
        : {}),
      ...(args.sha256 !== undefined ? { sha256: args.sha256 } : {}),
      runtime: args.runtime ?? "sandbox",
      ...(args.endpointUrl !== undefined
        ? { endpointUrl: args.endpointUrl }
        : {}),
      ...(args.endpointHeaders !== undefined
        ? { endpointHeaders: args.endpointHeaders }
        : {}),
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
    endpointUrl: v.optional(v.string()),
    endpointHeaders: v.optional(v.record(v.string(), v.string())),
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

    // A row carries exactly one execution definition. A runtime change drops
    // the other tier's fields instead of leaving dead bytes or endpoints.
    const targetRuntime = args.runtime ?? doc.runtime;
    const switchedToHttp =
      args.runtime !== undefined &&
      targetRuntime === "http" &&
      doc.runtime !== "http";
    const switchedToBundle =
      args.runtime !== undefined &&
      targetRuntime !== "http" &&
      doc.runtime === "http";

    await ctx.db.patch(normalized, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined
        ? { description: args.description }
        : {}),
      ...(args.inputSchema !== undefined
        ? { inputSchema: args.inputSchema }
        : {}),
      ...(switchedToHttp
        ? {
            sourceCode: undefined,
            sha256: undefined,
            bundleStorageKey: undefined,
          }
        : {}),
      ...(switchedToBundle
        ? { endpointUrl: undefined, endpointHeaders: undefined }
        : {}),
      ...(args.bundleStorageKey !== undefined
        ? { bundleStorageKey: args.bundleStorageKey }
        : {}),
      ...(args.sha256 !== undefined ? { sha256: args.sha256 } : {}),
      ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
      ...(args.endpointUrl !== undefined
        ? { endpointUrl: args.endpointUrl }
        : {}),
      ...(args.endpointHeaders !== undefined
        ? { endpointHeaders: args.endpointHeaders }
        : {}),
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
