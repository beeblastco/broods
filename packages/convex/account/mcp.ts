/**
 * Internal MCP server registration API (issue #331 phase 1). Rows are scoped
 * to one (projectId, stageId); core resolves a stage's servers at agent
 * registration time and connects over the stateless HTTP transport. Names are
 * unique per stage because they namespace the server's tools (`name__tool`).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveProjectStage } from "../model/projectScope";
import { mcpFields } from "../schema";

/** Full mcp row validator, shared with the dashboard-facing mcp service. */
export const mcpDoc = v.object({
  ...mcpFields,
  _id: v.id("mcp"),
  _creationTime: v.number(),
});

/**
 * Mint a storage upload URL for a hosted-MCP bundle too large to ride the
 * JSON body (#190). The blob is a courier: registering it deletes it.
 */
export const generateBundleUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    serverId: v.string(),
  },
  returns: v.union(mcpDoc, v.null()),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("mcp", args.serverId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId || doc.status !== "active")
      return null;

    return doc;
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(mcpDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("mcp")
      .withIndex("by_accountId_and_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "active"),
      )
      .collect();
  },
});

export const listForStage = internalQuery({
  args: { stageId: v.id("stages") },
  returns: v.array(mcpDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("mcp")
      .withIndex("by_stageId_and_status", (q) =>
        q.eq("stageId", args.stageId).eq("status", "active"),
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

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
    description: v.optional(v.string()),
    transport: v.optional(v.union(v.literal("http"), v.literal("hosted"))),
    url: v.optional(v.string()),
    bundleStorageKey: v.optional(v.string()),
    sha256: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
    allowedTools: v.optional(v.array(v.string())),
    disabled: v.optional(v.boolean()),
    nodeId: v.optional(v.string()),
    sourceCode: v.optional(v.string()),
  },
  returns: v.id("mcp"),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }
    // Every caller derives the scope from the same secret, but the project's
    // org is what actually ties a server to this account. Check it here.
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
    await requireNameFree(ctx, args.stageId, args.name);
    const transport = args.transport ?? "http";
    if (transport === "http" && !args.url) {
      throw new Error("url must be provided for an http MCP server");
    }
    if (transport === "hosted" && (!args.bundleStorageKey || !args.sha256)) {
      throw new Error("hosted MCP servers need bundleStorageKey and sha256");
    }

    const now = Date.now();

    return await ctx.db.insert("mcp", {
      accountId: args.accountId,
      projectId: args.projectId,
      stageId: args.stageId,
      name: args.name,
      description: args.description,
      transport: transport,
      url: args.url,
      bundleStorageKey: args.bundleStorageKey,
      sha256: args.sha256,
      headers: args.headers,
      allowedTools: args.allowedTools,
      disabled: args.disabled,
      nodeId: args.nodeId,
      sourceCode: args.sourceCode,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    serverId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("mcp", args.serverId);
    if (!normalized) {
      throw new Error("MCP server does not belong to the supplied accountId");
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) {
      throw new Error("MCP server does not belong to the supplied accountId");
    }

    await ctx.db.patch(normalized, {
      status: "deleted",
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    serverId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    transport: v.optional(v.union(v.literal("http"), v.literal("hosted"))),
    url: v.optional(v.string()),
    bundleStorageKey: v.optional(v.string()),
    sha256: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
    allowedTools: v.optional(v.array(v.string())),
    disabled: v.optional(v.boolean()),
    sourceCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("mcp", args.serverId);
    if (!normalized) {
      throw new Error("MCP server does not belong to the supplied accountId");
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId || doc.status !== "active") {
      throw new Error("MCP server does not belong to the supplied accountId");
    }
    if (args.name !== undefined && args.name !== doc.name) {
      await requireNameFree(ctx, doc.stageId, args.name);
    }

    await ctx.db.patch(normalized, updatePatch(args, doc));

    return null;
  },
});

/**
 * The fields an update writes. Provided args win; a transport switch clears
 * the other side's connection fields so a hosted row never carries a stale
 * url and vice versa; a bundle change that brings no source (a CLI sync over
 * a dashboard-authored row) clears the stored source rather than letting it
 * drift from the running bundle.
 */
function updatePatch(
  args: {
    name?: string;
    description?: string;
    transport?: "http" | "hosted";
    url?: string;
    bundleStorageKey?: string;
    sha256?: string;
    headers?: Record<string, string>;
    allowedTools?: string[];
    disabled?: boolean;
    sourceCode?: string;
  },
  doc: Doc<"mcp">,
): Partial<Doc<"mcp">> {
  return {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined
      ? { description: args.description }
      : {}),
    ...(args.transport !== undefined ? { transport: args.transport } : {}),
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.bundleStorageKey !== undefined
      ? { bundleStorageKey: args.bundleStorageKey }
      : {}),
    ...(args.sha256 !== undefined ? { sha256: args.sha256 } : {}),
    ...(args.headers !== undefined ? { headers: args.headers } : {}),
    ...(args.allowedTools !== undefined
      ? { allowedTools: args.allowedTools }
      : {}),
    ...(args.disabled !== undefined ? { disabled: args.disabled } : {}),
    ...(args.sourceCode !== undefined ? { sourceCode: args.sourceCode } : {}),
    ...(args.transport === "hosted" ? { url: undefined } : {}),
    ...(args.transport === "http"
      ? {
          bundleStorageKey: undefined,
          sha256: undefined,
          sourceCode: undefined,
        }
      : {}),
    ...(args.sha256 !== undefined &&
    args.sha256 !== doc.sha256 &&
    args.sourceCode === undefined
      ? { sourceCode: undefined }
      : {}),
    updatedAt: Date.now(),
  };
}

/** Throw when an active server already claims `name` on this stage. */
async function requireNameFree(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  name: string,
): Promise<void> {
  const existing = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_name", (q) =>
      q.eq("stageId", stageId).eq("name", name),
    )
    .collect();
  if (existing.some((doc) => doc.status === "active")) {
    throw new Error(`name must be unique per stage: ${name}`);
  }
}
