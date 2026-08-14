/**
 * Capability links for workspace files. A token is the whole credential, so it is
 * stored only as a SHA-256 hash and the plaintext lives nowhere but the URL that
 * was handed out. Redeeming one mints a fresh presigned S3 URL server-side, which
 * is what keeps AWS signature material out of chat clients entirely.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const MAX_DOWNLOAD_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60;
// Expired rows are dead weight, not a security boundary — redeeming always
// re-checks expiresAt. One bounded sweep per mint keeps the table from growing.
const PRUNE_BATCH_SIZE = 50;

const resolvedToken = v.object({
  accountId: v.id("accounts"),
  workspaceId: v.id("workspaceConfigs"),
  path: v.string(),
  filename: v.string(),
  expiresAt: v.number(),
});

/**
 * Look up a token by hash, ignoring anything already expired.
 * @param tokenHash SHA-256 hex of the presented token
 * @param now caller's clock in epoch millis
 * @returns the file the token grants, or null when unknown or expired
 */
export const resolveByHash = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.union(resolvedToken, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("workspaceDownloadTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!record || record.expiresAt <= args.now) return null;

    return {
      accountId: record.accountId,
      workspaceId: record.workspaceId,
      path: record.path,
      filename: record.filename,
      expiresAt: record.expiresAt,
    };
  },
});

/**
 * Store one download token and sweep a bounded batch of expired rows.
 * @param accountId account owning the workspace
 * @param workspaceId workspace the file lives in
 * @param path normalized workspace-relative path
 * @param filename name offered to whoever follows the link
 * @param tokenHash SHA-256 hex of the minted token
 * @param expiresAt epoch millis the token stops working
 * @param now caller's clock in epoch millis
 */
export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.id("workspaceConfigs"),
    path: v.string(),
    filename: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("workspaceDownloadTokens", {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      path: args.path,
      filename: args.filename,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      createdAt: args.now,
    });
    const stale = await ctx.db
      .query("workspaceDownloadTokens")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.now))
      .take(PRUNE_BATCH_SIZE);
    for (const record of stale) await ctx.db.delete(record._id);

    return null;
  },
});

/**
 * Revoke every token for one workspace. Deleting a workspace's files must not
 * leave links that still resolve.
 * @param workspaceId workspace whose tokens die
 * @returns the number of tokens revoked
 */
export const revokeForWorkspace = internalMutation({
  args: { workspaceId: v.id("workspaceConfigs") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("workspaceDownloadTokens")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    for (const record of records) await ctx.db.delete(record._id);

    return records.length;
  },
});
