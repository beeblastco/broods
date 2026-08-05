/**
 * Durable download artifacts: the rows behind the short links the agent's
 * download_url tool hands out. Core writes one per minted link and resolves it
 * again on every click; nothing here presigns or touches S3.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { downloadArtifactsFields } from "./schema";

const artifact = v.object({
  bucket: v.string(),
  key: v.string(),
  versionId: v.optional(v.string()),
  filename: v.string(),
  contentType: v.optional(v.string()),
  sizeBytes: v.optional(v.number()),
});

/**
 * Record a minted download link.
 * @param token unguessable public handle
 * @param accountId owning account, plus the S3 target and file metadata
 * @returns null
 */
export const create = internalMutation({
  args: {
    accountId: downloadArtifactsFields.accountId,
    workspaceId: downloadArtifactsFields.workspaceId,
    token: v.string(),
    bucket: v.string(),
    key: v.string(),
    versionId: v.optional(v.string()),
    path: v.string(),
    filename: v.string(),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    agentId: v.optional(v.string()),
    conversationKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("downloadArtifacts", {
      ...args,
      createdAt: Date.now(),
      downloadCount: 0,
    });

    return null;
  },
});

/**
 * Resolve a download token to its pinned S3 object.
 * @param token the public handle from the link
 * @returns the S3 target and file metadata, or null when the token is unknown
 */
export const getByToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(artifact, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("downloadArtifacts")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!row) return null;

    return {
      bucket: row.bucket,
      key: row.key,
      ...(row.versionId ? { versionId: row.versionId } : {}),
      filename: row.filename,
      ...(row.contentType ? { contentType: row.contentType } : {}),
      ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
    };
  },
});

/**
 * Count a download against its artifact. Best-effort telemetry, never gates the
 * redirect that already went out.
 * @param token the public handle from the link
 * @returns null
 */
export const recordDownload = internalMutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("downloadArtifacts")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        downloadCount: row.downloadCount + 1,
        lastDownloadedAt: Date.now(),
      });
    }

    return null;
  },
});
