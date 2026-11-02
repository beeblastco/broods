// Mutations, not queries: each mints the external id on first need.

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

export const externalId = internalMutation({
  args: { accountId: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const accountId = ctx.db.normalizeId("accounts", args.accountId);
    if (!accountId) throw new Error(`Account not found: ${args.accountId}`);

    return await ensureStorageExternalId(ctx, accountId);
  },
});

export const get = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: storageTrustValidator,
  handler: async (ctx, args): Promise<StorageTrust> => {
    return storageTrust(await ensureStorageExternalId(ctx, args.accountId));
  },
});

export const getForActiveOrg = mutation({
  args: {},
  returns: v.union(storageTrustValidator, v.null()),
  handler: async (ctx): Promise<StorageTrust | null> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const account = await getActiveAccountForUser(ctx);
    if (!account) return null;

    return storageTrust(await ensureStorageExternalId(ctx, account._id));
  },
});
