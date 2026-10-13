/**
 * The account's storage trust (external id + Broods principal) for its own
 * S3 roles: an internal mutation for core's mounts and the file actions, and a
 * dashboard mutation for the active org. Both mint the id on first need, which
 * is why neither is a query. The rules live in `model/storageTrust.ts`.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { authKit } from "../auth";
import {
  ensureStorageExternalId,
  storageTrust,
  type StorageTrust,
} from "../model/storageTrust";
import { getActiveAccountForUser } from "../org/orgs";

export const storageTrustValidator = v.object({
  externalId: v.string(),
  principalArn: v.optional(v.string()),
  trustPolicy: v.optional(v.string()),
});

/** The external id every AssumeRole of this account's own roles must send. */
export const externalId = internalMutation({
  args: { accountId: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    if (!accountId) throw new Error(`Account not found: ${args.accountId}`);

    return await ensureStorageExternalId(ctx, accountId);
  },
});

/** The full trust for one account, for `GET /v1/account/storage-trust`. */
export const get = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: storageTrustValidator,
  handler: async (ctx, args): Promise<StorageTrust> => {
    return storageTrust(await ensureStorageExternalId(ctx, args.accountId));
  },
});

/** The active org's trust, shown read-only in the workspace storage editor. */
export const getForActiveOrg = mutation({
  args: {},
  returns: v.union(storageTrustValidator, v.null()),
  handler: async (ctx): Promise<StorageTrust | null> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx);
    if (!account) return null;

    return storageTrust(await ensureStorageExternalId(ctx, account._id));
  },
});
