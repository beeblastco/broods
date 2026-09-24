"use node";

/**
 * Daily S3 storage snapshot for the usage meter. Sums each account's bytes on
 * the platform buckets (workspaces, chat attachments, skills, hook and MCP
 * bundles) and bills one day of them. A workspace on its own bucket costs the
 * platform nothing, and its managed-bucket prefix is empty, so it adds 0.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { listS3Prefix } from "../model/s3";
import { skillsBucketName } from "../model/skills";
import { filesystemBucketName } from "../model/workspaceFs";
import { workspaceNamespace } from "../model/workspaceRules";

const ACCOUNT_PAGE_SIZE = 100;
const WORKSPACE_PAGE_SIZE = 500;
const BYTES_PER_GB = 1e9;
// A day bills 1/30 of a GB-month; 31-day months come out 3% high, the safe side.
const DAYS_PER_MONTH = 30;
// Core's `ATTACHMENT_STORE_ROOT` (apps/core/src/shared/media-ticket.ts).
const ATTACHMENT_STORE_ROOT = "attachments/";

/** Daily cron: fan out one snapshot per account. */
export const snapshotAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    // Every account's day is billed to the month the snapshot was taken in,
    // even when its scheduled action runs after midnight.
    const snapshotAt = Date.now();
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result: {
        page: Id<"accounts">[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.account.budget.listAccountIds, {
        paginationOpts: { numItems: ACCOUNT_PAGE_SIZE, cursor: cursor },
      });
      for (const accountId of result.page) {
        await ctx.scheduler.runAfter(
          0,
          internal.aws.storageMeter.snapshotAccount,
          { accountId: accountId, snapshotAt: snapshotAt },
        );
      }
      cursor = result.continueCursor;
      isDone = result.isDone;
    }

    return null;
  },
});

/** Bill one day of the account's stored bytes. */
export const snapshotAccount = internalAction({
  args: { accountId: v.id("accounts"), snapshotAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const workspaceIds: Id<"workspaceConfigs">[] = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result: {
        page: Id<"workspaceConfigs">[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.account.budget.listWorkspaceIds, {
        accountId: args.accountId,
        paginationOpts: { numItems: WORKSPACE_PAGE_SIZE, cursor: cursor },
      });
      workspaceIds.push(...result.page);
      cursor = result.continueCursor;
      isDone = result.isDone;
    }
    const encoded = encodeURIComponent(args.accountId);
    const filesystem = filesystemBucketName();
    const bundles = process.env.TOOL_BUNDLES_BUCKET_NAME;
    const prefixes: [string, string][] = [
      [filesystem, `${ATTACHMENT_STORE_ROOT}${encoded}/`],
      [skillsBucketName(), `${args.accountId}/`],
    ];
    if (bundles) {
      prefixes.push(
        [bundles, `account-hooks/${encoded}/`],
        [bundles, `account-mcp/${encoded}/`],
      );
    }
    for (const workspaceId of workspaceIds) {
      const namespace = await workspaceNamespace(args.accountId, workspaceId);
      prefixes.push([filesystem, `${namespace}/`]);
    }
    let bytes = 0;
    for (const [bucket, prefix] of prefixes) {
      for (const object of await listS3Prefix(bucket, prefix)) {
        bytes += object.size ?? 0;
      }
    }
    await ctx.runMutation(internal.account.budget.record, {
      accountId: args.accountId,
      usage: { storageGbMonths: bytes / BYTES_PER_GB / DAYS_PER_MONTH },
      at: args.snapshotAt,
    });

    return null;
  },
});
