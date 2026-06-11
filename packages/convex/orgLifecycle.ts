"use node";
/**
 * Provision and rotate the per-org filthy-panty Bearer secret. The plaintext
 * is returned to the caller exactly once at provisioning or rotation time;
 * only the SHA-256 hash is stored in the `accounts` row.
 */

import { v } from "convex/values";
import { createHash, randomBytes } from "node:crypto";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

const ACCOUNT_SECRET_PREFIX = "fp_acct_";

function generateAccountSecret(): { secret: string; secretHash: string } {
    const secret = `${ACCOUNT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const secretHash = createHash("sha256").update(secret).digest("hex");
    return { secret: secret, secretHash: secretHash };
}

export const provision = action({
    args: { orgId: v.id("orgs") },
    returns: v.object({
        accountId: v.id("accounts"),
        secret: v.string(),
    }),
    handler: async (ctx, args): Promise<{ accountId: Id<"accounts">; secret: string }> => {
        const org = await ctx.runQuery(api.org.getById, { orgId: args.orgId });
        if (!org) {
            throw new Error("Org not found or you are not a member");
        }

        const existing = await ctx.runQuery(internal.accounts.getByOrgId, { orgId: args.orgId });
        if (existing) {
            throw new Error(
                "Account already provisioned for this org; use rotate to issue a new secret",
            );
        }

        const { secret, secretHash } = generateAccountSecret();
        const accountId = await ctx.runMutation(internal.accounts.create, {
            orgId: args.orgId,
            username: org.slug,
            description: `Cherry-coke org ${org.name}`,
            secretHash: secretHash,
        });

        return { accountId: accountId, secret: secret };
    },
});

export const rotateSecret = action({
    args: { orgId: v.id("orgs") },
    returns: v.object({ secret: v.string() }),
    handler: async (ctx, args) => {
        const org = await ctx.runQuery(api.org.getById, { orgId: args.orgId });
        if (!org) {
            throw new Error("Org not found or you are not a member");
        }

        const account = await ctx.runQuery(internal.accounts.getByOrgId, { orgId: args.orgId });
        if (!account) {
            throw new Error("Account not provisioned for this org");
        }

        const { secret, secretHash } = generateAccountSecret();
        await ctx.runMutation(internal.accounts.update, {
            accountId: account._id,
            secretHash: secretHash,
        });

        return { secret: secret };
    },
});
