"use node";
/**
 * Provision and rotate the per-org filthy-panty Bearer secret. The plaintext
 * is returned to the caller exactly once at provisioning or rotation time;
 * only the SHA-256 hash is stored in the `accounts` row.
 */
import { v } from "convex/values";
import { createHash, randomBytes } from "node:crypto";
import { api, internal } from "./_generated/api";
import { action } from "./_generated/server";

const ACCOUNT_SECRET_PREFIX = "fp_acct_";

function generateAccountSecret(): { secret: string; secretHash: string } {
    const secret = `${ACCOUNT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const secretHash = createHash("sha256").update(secret).digest("hex");

    return { secret: secret, secretHash: secretHash };
}

/**
 * Provisions the backend `accounts` row for an org owned/admin'd by the
 * caller and returns the plaintext Bearer secret exactly once.
 */
export const provision = action({
    args: { orgId: v.id("orgs") },
    returns: v.object({
        accountId: v.id("accounts"),
        secret: v.string(),
    }),
    handler: async (ctx, args) => {
        const { orgId } = args;

        const org = await ctx.runQuery(api.org.getById, { orgId: orgId });
        if (!org) {
            throw new Error("Org not found or you are not a member");
        }

        const existing = await ctx.runQuery(
            internal.accounts.getByOrgId,
            { orgId: orgId },
        );
        if (existing) {
            throw new Error(
                "Account already provisioned for this org; use rotate to issue a new secret",
            );
        }

        const { secret, secretHash } = generateAccountSecret();
        const accountId = await ctx.runMutation(
            internal.accounts.create,
            {
                orgId: orgId,
                username: org.slug,
                description: `Cherry-coke org ${org.name}`,
                secretHash: secretHash,
            },
        );

        return { accountId: accountId, secret: secret };
    },
});

/**
 * Rotates the org's Bearer secret. Old secret is invalidated immediately and
 * the new plaintext is returned exactly once.
 */
export const rotateSecret = action({
    args: { orgId: v.id("orgs") },
    returns: v.object({ secret: v.string() }),
    handler: async (ctx, args) => {
        const { orgId } = args;

        const org = await ctx.runQuery(api.org.getById, { orgId: orgId });
        if (!org) {
            throw new Error("Org not found or you are not a member");
        }

        const account = await ctx.runQuery(
            internal.accounts.getByOrgId,
            { orgId: orgId },
        );
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
