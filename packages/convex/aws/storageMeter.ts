"use node";

// A workspace on its own bucket has an empty managed-bucket prefix, so it bills 0.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { DAYS_PER_MONTH } from "../model/pricing";
import { listS3Prefix } from "../model/s3";
import { skillsBucketName } from "../model/skills";
import { filesystemBucketName } from "../model/workspaceFs";
import { workspaceNamespace } from "../model/workspaceRules";

const ACCOUNT_PAGE_SIZE = 100;
const WORKSPACE_PAGE_SIZE = 500;
const BYTES_PER_GB = 1e9;
// Core's `ATTACHMENT_STORE_ROOT` (apps/core/src/shared/media-ticket.ts).
const ATTACHMENT_STORE_ROOT = "attachments/";

export const snapshotAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    // One timestamp for all: an action that runs after midnight bills the snapshot's month.
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

export const snapshotAccount = internalAction({
  args: { accountId: v.id("accounts"), snapshotAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const workspaces: Array<{
      workspaceId: Id<"workspaceConfigs">;
      projectId?: Id<"projects">;
    }> = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const result: {
        page: typeof workspaces;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.account.budget.listWorkspaces, {
        accountId: args.accountId,
        paginationOpts: { numItems: WORKSPACE_PAGE_SIZE, cursor: cursor },
      });
      workspaces.push(...result.page);
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
    let bytes = 0;
    for (const [bucket, prefix] of prefixes) {
      bytes += await prefixBytes(bucket, prefix);
    }
    const projectBytes = new Map<Id<"projects">, number>();
    for (const { workspaceId, projectId } of workspaces) {
      const namespace = await workspaceNamespace(args.accountId, workspaceId);
      const held = await prefixBytes(filesystem, `${namespace}/`);
      bytes += held;
      if (projectId) {
        projectBytes.set(projectId, (projectBytes.get(projectId) ?? 0) + held);
      }
    }
    await ctx.runMutation(internal.account.budget.record, {
      accountId: args.accountId,
      usage: { storageGbMonths: toGbMonths(bytes) },
      at: args.snapshotAt,
      projectStorage: [...projectBytes].map(([projectId, held]) => ({
        projectId: projectId,
        storageGbMonths: toGbMonths(held),
      })),
    });

    return null;
  },
});

async function prefixBytes(bucket: string, prefix: string): Promise<number> {
  let bytes = 0;
  for (const object of await listS3Prefix(bucket, prefix)) {
    bytes += object.size ?? 0;
  }

  return bytes;
}

function toGbMonths(bytes: number): number {
  return bytes / BYTES_PER_GB / DAYS_PER_MONTH;
}
