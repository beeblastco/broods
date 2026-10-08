"use node";
/**
 * Provision and rotate the per-org account key. The plaintext
 * is returned to the caller exactly once at provisioning or rotation time;
 * only the SHA-256 hash is stored in the `accounts` row.
 */

import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import {
  ACCOUNT_KEY_PREFIX,
  createAccountSecret,
  sha256Hex,
} from "../model/accountSecrets";
import { ClientError } from "../model/clientError";

export const provision = action({
  args: { orgId: v.id("orgs") },
  returns: v.object({
    accountId: v.id("accounts"),
    secret: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ accountId: Id<"accounts">; secret: string }> => {
    const org = await ctx.runQuery(api.org.orgs.getByIdForAdmin, {
      orgId: args.orgId,
    });
    if (!org) {
      throw new ClientError("Org not found or admin role required");
    }

    const existing = await ctx.runQuery(internal.account.accounts.getByOrgId, {
      orgId: args.orgId,
    });
    if (existing) {
      throw new ClientError(
        "Account already provisioned for this org; use rotate to issue a new secret",
        "conflict",
      );
    }

    const secret = createAccountSecret();
    const identity = await ctx.auth.getUserIdentity();
    const account = await ctx.runMutation(internal.account.accounts.create, {
      orgId: args.orgId,
      username: org.slug,
      description: `Cherry-coke org ${org.name}`,
      secretHash: await sha256Hex(secret),
      secretHint: secretHint(secret),
      secretRotatedBy: await userIdOf(ctx, identity?.subject),
    });

    console.log("AUDIT account key provisioned", {
      orgId: args.orgId,
      accountId: account._id,
      actor: identity?.subject ?? "unknown",
    });

    return { accountId: account._id, secret: secret };
  },
});

export const rotateSecret = action({
  args: { orgId: v.id("orgs") },
  returns: v.object({ secret: v.string() }),
  handler: async (ctx, args): Promise<{ secret: string }> => {
    const org = await ctx.runQuery(api.org.orgs.getByIdForAdmin, {
      orgId: args.orgId,
    });
    if (!org) {
      throw new Error("Org not found or admin role required");
    }

    const account = await ctx.runQuery(internal.account.accounts.getByOrgId, {
      orgId: args.orgId,
    });
    if (!account) {
      throw new Error("Account not provisioned for this org");
    }

    const secret = createAccountSecret();
    const identity = await ctx.auth.getUserIdentity();
    await ctx.runMutation(internal.account.accounts.update, {
      accountId: account._id,
      secretHash: await sha256Hex(secret),
      secretHint: secretHint(secret),
      secretRotatedBy: await userIdOf(ctx, identity?.subject),
    });

    console.log("AUDIT account key rotated", {
      orgId: args.orgId,
      accountId: account._id,
      actor: identity?.subject ?? "unknown",
    });

    return { secret: secret };
  },
});

/** Masked label for the key list: prefix plus the last four characters. */
function secretHint(secret: string): string {
  return `${ACCOUNT_KEY_PREFIX}…${secret.slice(-4)}`;
}

/** The member row behind the caller's auth id, so the key list can name them. */
async function userIdOf(
  ctx: ActionCtx,
  authId: string | undefined,
): Promise<Id<"users"> | undefined> {
  if (!authId) return undefined;
  const user: { _id: Id<"users"> } | null = await ctx.runQuery(
    internal.org.orgs.userByAuthId,
    { authId: authId },
  );

  return user?._id;
}
