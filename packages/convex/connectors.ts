/**
 * Connector rows: internal CRUD plus the runtime read core uses to resolve
 * `config.connectors.allowed` into live tools. Every access revalidates the
 * accountId. Secrets stay encrypted at rest; `listForRuntime` returns the
 * blobs for core to decrypt with the shared account-config secret — the
 * dashboard-facing surface (connectorsPublic) never returns them.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { connectorsFields } from "./schema";

const connectorDoc = v.object({
  ...connectorsFields,
  _id: v.id("connectors"),
  _creationTime: v.number(),
});

export const getById = internalQuery({
  args: { accountId: v.id("accounts"), connectorId: v.id("connectors") },
  returns: v.union(connectorDoc, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectorId);
    if (!row || row.accountId !== args.accountId) return null;

    return row;
  },
});

export const listForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(connectorDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("connectors")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

/**
 * Runtime resolution read (core): the requested connector rows of one
 * account, including encrypted secret blobs. accountId is a string here
 * because the runtime addresses accounts by id string.
 */
export const listForRuntime = internalQuery({
  args: { accountId: v.string(), connectorIds: v.array(v.string()) },
  returns: v.array(connectorDoc),
  handler: async (ctx, args) => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    if (!accountId) return [];
    const rows = [];
    for (const id of args.connectorIds) {
      const normalized = ctx.db.normalizeId("connectors", id);
      if (!normalized) continue;
      const row = await ctx.db.get(normalized);
      if (row && row.accountId === accountId) rows.push(row);
    }

    return rows;
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    provider: v.string(),
    label: v.string(),
    authKind: v.union(v.literal("token"), v.literal("mcp")),
    url: v.optional(v.string()),
    encryptedSecret: v.optional(v.string()),
    secretIv: v.optional(v.string()),
    secretTag: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("error")),
    toolNames: v.optional(v.array(v.string())),
    validatedLogin: v.optional(v.string()),
  },
  returns: v.id("connectors"),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error(`Account not found: ${args.accountId}`);
    const now = Date.now();

    return await ctx.db.insert("connectors", {
      ...args,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const patchStatus = internalMutation({
  args: {
    accountId: v.id("accounts"),
    connectorId: v.id("connectors"),
    status: v.union(v.literal("connected"), v.literal("error")),
    lastError: v.optional(v.string()),
    toolNames: v.optional(v.array(v.string())),
    validatedLogin: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectorId);
    if (!row || row.accountId !== args.accountId) {
      throw new Error("Connector does not belong to the supplied accountId");
    }
    const now = Date.now();
    await ctx.db.patch(args.connectorId, {
      status: args.status,
      lastError: args.status === "error" ? args.lastError : undefined,
      ...(args.toolNames !== undefined ? { toolNames: args.toolNames } : {}),
      ...(args.validatedLogin !== undefined
        ? { validatedLogin: args.validatedLogin }
        : {}),
      lastCheckedAt: now,
      updatedAt: now,
    });

    return null;
  },
});

export const remove = internalMutation({
  args: { accountId: v.id("accounts"), connectorId: v.id("connectors") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectorId);
    if (!row || row.accountId !== args.accountId) return null;
    await ctx.db.delete(args.connectorId);

    return null;
  },
});
