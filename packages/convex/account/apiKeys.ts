/**
 * Scoped account keys as the bearer resolvers see them. A `bask_` whose hash
 * is not the account key's resolves here to the role principal it acts as,
 * so the config plane and core judge it with `authorize()` like a role
 * session. The dashboard makes, edits and revokes them in `accountApiKeys.ts`.
 */

import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { accountDoc } from "../model/accountDoc";
import { rolePrincipalValidator } from "./roles";

/** How stale `lastUsedAt` may get before a request stamps it again, as core throttles runtime keys. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

const resolvedKeyValidator = v.object({
  keyId: v.id("accountApiKeys"),
  account: accountDoc,
  principal: rolePrincipalValidator,
  stampDue: v.boolean(),
});

type ResolvedKey = Infer<typeof resolvedKeyValidator>;

/**
 * A live key on an active account: the principal it acts as, its account,
 * and whether this request should stamp `lastUsedAt`. Null for an unknown
 * or expired key, or a disabled account. The caller passes `now`, so a
 * cached result never outlives the time it was judged at.
 */
export const resolve = internalQuery({
  args: { keyHash: v.string(), now: v.number() },
  returns: v.union(resolvedKeyValidator, v.null()),
  handler: async (ctx, args): Promise<ResolvedKey | null> => {
    const { now } = args;
    const key = await ctx.db
      .query("accountApiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .unique();
    if (!key || (key.expiresAt !== undefined && key.expiresAt <= now)) {
      return null;
    }
    const account = await ctx.db.get(key.accountId);
    if (!account || account.status !== "active") return null;

    return {
      keyId: key._id,
      account: account,
      principal: {
        accountId: key.accountId,
        roleId: key._id,
        policy: key.policy,
        ...(key.projectId !== undefined ? { projectId: key.projectId } : {}),
        ...(key.stageId !== undefined ? { stageId: key.stageId } : {}),
      },
      stampDue: now - (key.lastUsedAt ?? 0) >= LAST_USED_WRITE_INTERVAL_MS,
    };
  },
});

/**
 * Stamp a key's last use. A stamp within the interval of the stored one is
 * dropped, so a burst of requests that all saw `stampDue` writes once.
 */
export const touchLastUsed = internalMutation({
  args: { keyId: v.id("accountApiKeys"), usedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const key = await ctx.db.get(args.keyId);
    if (
      key &&
      args.usedAt - (key.lastUsedAt ?? 0) >= LAST_USED_WRITE_INTERVAL_MS
    ) {
      await ctx.db.patch(key._id, { lastUsedAt: args.usedAt });
    }

    return null;
  },
});
