/**
 * Scoped account keys as the bearer resolvers see them. A `bask_` whose hash
 * is not the account key's resolves here to the role principal it acts as,
 * so the config plane and core judge it with `authorize()` like a role
 * session. The dashboard makes, edits and revokes them in `accountApiKeys.ts`.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { rolePrincipalValidator } from "./roles";

/** How stale `lastUsedAt` may get before a request stamps it again, as core throttles runtime keys. */
export const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The principal a live key acts as, with its id for the audit actor. Null
 * for an unknown or expired key; the caller loads the account and checks its
 * status.
 */
export const resolve = internalQuery({
  args: { keyHash: v.string() },
  returns: v.union(
    v.object({
      keyId: v.id("accountApiKeys"),
      lastUsedAt: v.optional(v.number()),
      principal: rolePrincipalValidator,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("accountApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .unique();
    if (!key || (key.expiresAt !== undefined && key.expiresAt <= Date.now()))
      return null;

    return {
      keyId: key._id,
      lastUsedAt: key.lastUsedAt,
      principal: {
        accountId: key.accountId,
        roleId: key._id,
        policy: key.policy,
        ...(key.projectId !== undefined ? { projectId: key.projectId } : {}),
        ...(key.stageId !== undefined ? { stageId: key.stageId } : {}),
      },
    };
  },
});

/** Stamp a key's last use; a write older than the stored one is dropped. */
export const touchLastUsed = internalMutation({
  args: { keyId: v.id("accountApiKeys"), usedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (key && (key.lastUsedAt ?? 0) < args.usedAt) {
      await ctx.db.patch(key._id, { lastUsedAt: args.usedAt });
    }

    return null;
  },
});
