/**
 * WorkOS-backed CLI login codes and bearer tokens.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { authKit } from "./auth";
import { getActiveOrgForUser, requireOrgMember } from "./model/ownership/org";

const CLI_CODE_PREFIX = "fp_code_";
const CLI_TOKEN_PREFIX = "fp_cli_";
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLI_TOKEN_LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function randomToken(prefix: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);

    return `${prefix}${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Mint a short-lived one-time login code for the authenticated user's active org. */
export const createLoginCode = mutation({
    args: {},
    returns: v.object({ code: v.string(), expiresAt: v.number() }),
    handler: async (ctx) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", authUser.id))
            .unique();
        if (!user) throw new Error("User not found");

        const org = await getActiveOrgForUser(ctx, user._id);
        if (!org) throw new Error("No active org");
        await requireOrgMember(ctx, org._id, user._id, "admin");

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .unique();
        if (!account || account.status !== "active") {
            throw new Error("Provision your organization's API account first (Settings -> API Access).");
        }

        const now = Date.now();
        const code = randomToken(CLI_CODE_PREFIX);
        const expiresAt = now + CODE_TTL_MS;
        await ctx.db.insert("cliAuthCodes", {
            codeHash: await sha256Hex(code),
            authId: authUser.id,
            orgId: org._id,
            accountId: account._id,
            expiresAt: expiresAt,
            createdAt: now,
        });

        return { code: code, expiresAt: expiresAt };
    },
});

/** Exchange a one-time code for a long-lived CLI bearer token. */
export const exchangeLoginCode = internalMutation({
    args: { code: v.string() },
    returns: v.object({
        token: v.string(),
        expiresAt: v.number(),
        user: v.object({
            authId: v.string(),
            email: v.string(),
            name: v.string(),
        }),
        org: v.object({
            id: v.string(),
            name: v.string(),
            slug: v.string(),
        }),
        account: v.object({
            id: v.string(),
            username: v.string(),
        }),
    }),
    handler: async (ctx, { code }) => {
        const codeHash = await sha256Hex(code);
        const row = await ctx.db
            .query("cliAuthCodes")
            .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
            .unique();
        const now = Date.now();
        if (!row || row.usedAt || row.expiresAt < now) {
            throw new Error("CLI login code is invalid or expired");
        }

        const account = await ctx.db.get(row.accountId);
        if (!account || account.status !== "active") throw new Error("Account is not active");
        const org = await ctx.db.get(row.orgId);
        if (!org) throw new Error("Organization not found");
        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", row.authId))
            .unique();

        const token = randomToken(CLI_TOKEN_PREFIX);
        const expiresAt = now + TOKEN_TTL_MS;
        await ctx.db.insert("cliTokens", {
            tokenHash: await sha256Hex(token),
            authId: row.authId,
            orgId: row.orgId,
            accountId: row.accountId,
            status: "active",
            expiresAt: expiresAt,
            createdAt: now,
            lastUsedAt: now,
        });
        await ctx.db.patch(row._id, { usedAt: now });

        return {
            token: token,
            expiresAt: expiresAt,
            user: {
                authId: row.authId,
                email: user?.email ?? "",
                name: user?.name ?? user?.email ?? row.authId,
            },
            org: {
                id: row.orgId,
                name: org.name,
                slug: org.slug,
            },
            account: {
                id: row.accountId,
                username: account.username,
            },
        };
    },
});

/**
 * Resolve a CLI token to the account secret hash used by existing sync code.
 * Touches lastUsedAt at a coarse interval to avoid write contention.
 */
export const resolveCliToken = internalMutation({
    args: {
        tokenHash: v.string(),
    },
    returns: v.union(
        v.null(),
        v.object({
            accountId: v.id("accounts"),
            secretHash: v.string(),
            cliTokenId: v.id("cliTokens"),
        }),
    ),
    handler: async (ctx, args) => {
        const token = await ctx.db
            .query("cliTokens")
            .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
            .unique();
        const now = Date.now();
        if (!token || token.status !== "active" || (token.expiresAt !== undefined && token.expiresAt < now)) {
            return null;
        }

        const account = await ctx.db.get(token.accountId);
        if (!account || account.status !== "active") return null;

        if (
            token.lastUsedAt === undefined ||
            now - token.lastUsedAt >= CLI_TOKEN_LAST_USED_WRITE_INTERVAL_MS
        ) {
            await ctx.db.patch(token._id, { lastUsedAt: now });
        }

        return {
            accountId: token.accountId,
            secretHash: account.secretHash,
            cliTokenId: token._id,
        };
    },
});
