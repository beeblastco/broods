/**
 * WorkOS-backed CLI login codes and bearer tokens.
 */

import { v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authKit } from "./auth";
import { getActiveOrgForUser, requireOrgMember } from "./model/ownership/org";

const CLI_CODE_PREFIX = "fp_code_";
const CLI_TOKEN_PREFIX = "fp_cli_";
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLI_TOKEN_LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

const onboardingOrgValidator = v.object({
    id: v.id("orgs"),
    name: v.string(),
    slug: v.string(),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    accountStatus: v.union(v.literal("active"), v.literal("missing"), v.literal("disabled")),
});

const onboardingProjectValidator = v.object({
    id: v.id("projects"),
    name: v.string(),
    slug: v.string(),
});

const onboardingContextValidator = v.object({
    currentOrgId: v.id("orgs"),
    orgs: v.array(onboardingOrgValidator),
    projects: v.array(onboardingProjectValidator),
});

type OnboardingOrg = {
    id: Id<"orgs">;
    name: string;
    slug: string;
    role: "owner" | "admin" | "member";
    accountStatus: "active" | "disabled" | "missing";
};

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
            authId: v.string(),
            orgId: v.id("orgs"),
        }),
    ),
    handler: async (ctx, args) => {
        const resolved = await resolveActiveCliToken(ctx, args.tokenHash);
        if (!resolved) return null;
        const { token, account } = resolved;

        return {
            accountId: token.accountId,
            secretHash: account.secretHash,
            cliTokenId: token._id,
            authId: token.authId,
            orgId: token.orgId,
        };
    },
});

/** Returns selectable orgs and projects for the current CLI token context. */
export const getOnboardingContext = internalMutation({
    args: { tokenHash: v.string() },
    returns: v.union(v.null(), onboardingContextValidator),
    handler: async (ctx, args) => {
        const resolved = await resolveActiveCliToken(ctx, args.tokenHash);
        if (!resolved) return null;

        return await onboardingContext(ctx, resolved.token.authId, resolved.token.orgId);
    },
});

/** Switches the current CLI token to another org where the user can manage resources. */
export const selectOnboardingOrg = internalMutation({
    args: {
        tokenHash: v.string(),
        orgId: v.id("orgs"),
    },
    returns: v.union(v.null(), onboardingContextValidator),
    handler: async (ctx, args) => {
        const resolved = await resolveActiveCliToken(ctx, args.tokenHash);
        if (!resolved) return null;
        const { token } = resolved;
        const user = await userForAuthId(ctx, token.authId);
        if (!user) throw new Error("CLI token user was not found");
        const membership = await ctx.db
            .query("orgMembers")
            .withIndex("by_orgId_and_userId", (q) =>
                q.eq("orgId", args.orgId).eq("userId", user._id),
            )
            .unique();
        if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
            throw new Error("CLI org selection requires owner or admin role");
        }

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
            .unique();
        if (!account || account.status !== "active") {
            throw new Error("Selected org does not have an active API account");
        }

        await ctx.db.patch(token._id, {
            orgId: args.orgId,
            accountId: account._id,
            lastUsedAt: Date.now(),
        });

        return await onboardingContext(ctx, token.authId, args.orgId);
    },
});

async function resolveActiveCliToken(ctx: MutationCtx, tokenHash: string) {
    const token = await ctx.db
        .query("cliTokens")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
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

    return { token: token, account: account };
}

async function userForAuthId(ctx: MutationCtx, authId: string) {
    const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", authId))
        .unique();

    return user ?? null;
}

async function onboardingContext(
    ctx: MutationCtx,
    authId: string,
    currentOrgId: Id<"orgs">,
) {
    const user = await userForAuthId(ctx, authId);
    if (!user) throw new Error("CLI token user was not found");
    const memberships = await ctx.db
        .query("orgMembers")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .collect();
    const orgs: OnboardingOrg[] = [];
    for (const membership of memberships) {
        if (membership.role !== "owner" && membership.role !== "admin") continue;
        const org = await ctx.db.get(membership.orgId);
        if (!org) continue;
        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .unique();
        const accountStatus: OnboardingOrg["accountStatus"] = account?.status ?? "missing";
        orgs.push({
            id: org._id,
            name: org.name,
            slug: org.slug,
            role: membership.role,
            accountStatus: accountStatus,
        });
    }

    const projects = await ctx.db
        .query("projects")
        .withIndex("by_orgId", (q) => q.eq("orgId", currentOrgId))
        .collect();

    return {
        currentOrgId: currentOrgId,
        orgs: orgs.sort((a, b) => a.name.localeCompare(b.name)),
        projects: projects
            .map((project) => ({
                id: project._id,
                name: project.name,
                slug: project.slug,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
}
