/**
 * WorkOS-backed CLI login codes and bearer tokens, plus the HTTP exchange
 * endpoint that swaps a one-time login code for a token.
 */

import { v, type Infer } from "convex/values";
import {
  httpAction,
  internalMutation,
  mutation,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { authKit } from "../auth";
import { slugifyName } from "../lib/slug";
import { sha256Hex } from "../model/accountSecrets";
import {
  getActiveOrgForUser,
  getOrgMembership,
  orgRoleMeets,
  requireOrgMember,
} from "../model/ownership/org";

const CLI_CODE_PREFIX = "fp_code_";
// RFC 7636: 43..128 unreserved characters, base64url without padding.
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CLI_TOKEN_LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export const CLI_TOKEN_PREFIX = "fp_cli_";
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// planValidator stays ahead of onboardingOrgValidator, which embeds it;
// onboardingContextValidator embeds the rest and comes last.
const planValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("enterprise"),
);

/** The API account backing the token's current org; `broods whoami` reports it. */
const onboardingAccountValidator = v.object({
  id: v.id("accounts"),
  username: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
});

const onboardingOrgValidator = v.object({
  id: v.id("orgs"),
  name: v.string(),
  slug: v.string(),
  role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
  plan: planValidator,
  accountStatus: v.union(
    v.literal("active"),
    v.literal("missing"),
    v.literal("disabled"),
  ),
});

const onboardingProjectValidator = v.object({
  id: v.id("projects"),
  name: v.string(),
  slug: v.string(),
});

const onboardingUserValidator = v.object({
  authId: v.string(),
  email: v.string(),
  name: v.string(),
});

const onboardingContextValidator = v.object({
  currentOrgId: v.id("orgs"),
  orgs: v.array(onboardingOrgValidator),
  projects: v.array(onboardingProjectValidator),
  account: v.union(v.null(), onboardingAccountValidator),
  user: onboardingUserValidator,
});

type OnboardingOrg = {
  id: Id<"orgs">;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  plan: "free" | "pro" | "enterprise";
  accountStatus: "active" | "disabled" | "missing";
};

/**
 * Mint a short-lived one-time login code for the authenticated user's active
 * org. With a PKCE `codeChallenge`, only the CLI process holding the verifier
 * can exchange the code, so a stray localhost listener that catches it gets
 * nothing.
 */
export const createLoginCode = mutation({
  args: { codeChallenge: v.optional(v.string()) },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { codeChallenge }) => {
    if (
      codeChallenge !== undefined &&
      !PKCE_CHALLENGE_PATTERN.test(codeChallenge)
    ) {
      throw new Error("codeChallenge must be a base64url S256 challenge");
    }
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
      throw new Error(
        "Provision your organization's API account first (Settings -> API Access).",
      );
    }

    const now = Date.now();
    const code = randomToken(CLI_CODE_PREFIX);
    const expiresAt = now + CODE_TTL_MS;
    await ctx.db.insert("cliAuthCodes", {
      codeHash: await sha256Hex(code),
      authId: authUser.id,
      orgId: org._id,
      accountId: account._id,
      ...(codeChallenge ? { codeChallenge: codeChallenge } : {}),
      expiresAt: expiresAt,
      createdAt: now,
    });

    return { code: code, expiresAt: expiresAt };
  },
});

/** Creates a new org for the CLI token user and switches the token to it. */
export const createOnboardingOrg = internalMutation({
  args: {
    tokenHash: v.string(),
    name: v.string(),
  },
  returns: v.union(v.null(), onboardingContextValidator),
  handler: async (ctx, args) => {
    const resolved = await resolveActiveCliToken(ctx, args.tokenHash);
    if (!resolved) return null;
    const { token } = resolved;
    const user = await userForAuthId(ctx, token.authId);
    if (!user) throw new Error("CLI token user was not found");
    const name = args.name.trim();
    if (!name) throw new Error("Organization name is required");

    const now = Date.now();
    const slug = await uniqueOrgSlug(ctx, name);
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: slug,
      ownerAuthId: token.authId,
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: user._id,
      role: "owner",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: slug,
      description: `Broods org ${name}`,
      secretHash: await sha256Hex(randomToken("fp_acct_")),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(user._id, { activeOrgId: orgId });
    await ctx.db.patch(token._id, {
      orgId: orgId,
      accountId: accountId,
      lastUsedAt: now,
    });

    return await onboardingContext(ctx, token.authId, orgId);
  },
});

/** HTTP exchange endpoint: swap a one-time WorkOS-backed login code for a CLI token. */
export const exchange = httpAction(async (ctx, req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: { code?: unknown; code_verifier?: unknown };
  try {
    body = (await req.json()) as { code?: unknown; code_verifier?: unknown };
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  if (typeof body.code !== "string" || !body.code.trim()) {
    return json({ error: "Request body must include code" }, 400);
  }

  try {
    const result: Record<string, unknown> = await ctx.runMutation(
      internal.cli.auth.exchangeLoginCode,
      {
        code: body.code,
        ...(typeof body.code_verifier === "string"
          ? { codeVerifier: body.code_verifier }
          : {}),
      },
    );

    return json(result);
  } catch (error) {
    console.error("CLI login exchange failed", error);
    if (
      error instanceof Error &&
      error.message.includes("CLI login code is invalid or expired")
    ) {
      return json({ error: "Login code is invalid or expired" }, 400);
    }

    return json({ error: "Login exchange failed" }, 500);
  }
});

/** Exchange a one-time code for a long-lived CLI bearer token. */
export const exchangeLoginCode = internalMutation({
  args: { code: v.string(), codeVerifier: v.optional(v.string()) },
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
  handler: async (ctx, { code, codeVerifier }) => {
    const codeHash = await sha256Hex(code);
    const row = await ctx.db
      .query("cliAuthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    const now = Date.now();
    if (!row || row.usedAt || row.expiresAt < now) {
      throw new Error("CLI login code is invalid or expired");
    }
    if (
      row.codeChallenge &&
      (!codeVerifier ||
        (await pkceChallenge(codeVerifier)) !== row.codeChallenge)
    ) {
      throw new Error("CLI login code is invalid or expired");
    }

    const account = await ctx.db.get(row.accountId);
    if (!account || account.status !== "active")
      throw new Error("Account is not active");
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

/** Returns selectable orgs and projects for the current CLI token context. */
export const getOnboardingContext = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.union(v.null(), onboardingContextValidator),
  handler: async (ctx, args) => {
    const resolved = await resolveActiveCliToken(ctx, args.tokenHash);
    if (!resolved) return null;

    return await onboardingContext(
      ctx,
      resolved.token.authId,
      resolved.token.orgId,
    );
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
    if (
      !membership ||
      (membership.role !== "owner" && membership.role !== "admin")
    ) {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

async function onboardingContext(
  ctx: MutationCtx,
  authId: string,
  currentOrgId: Id<"orgs">,
): Promise<Infer<typeof onboardingContextValidator>> {
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
    const accountStatus: OnboardingOrg["accountStatus"] =
      account?.status ?? "missing";
    orgs.push({
      id: org._id,
      name: org.name,
      slug: org.slug,
      role: membership.role,
      plan: org.plan,
      accountStatus: accountStatus,
    });
  }

  const projects = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", currentOrgId))
    .collect();
  const currentAccount = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", currentOrgId))
    .unique();

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
    account: currentAccount
      ? {
          id: currentAccount._id,
          username: currentAccount.username,
          status: currentAccount.status,
        }
      : null,
    user: {
      authId: user.authId,
      email: user.email,
      name: user.name,
    },
  };
}

/** S256 PKCE transform: base64url(sha256(verifier)), no padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return `${prefix}${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

async function resolveActiveCliToken(
  ctx: MutationCtx,
  tokenHash: string,
): Promise<{ token: Doc<"cliTokens">; account: Doc<"accounts"> } | null> {
  const token = await ctx.db
    .query("cliTokens")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  const now = Date.now();
  if (
    !token ||
    token.status !== "active" ||
    (token.expiresAt !== undefined && token.expiresAt < now)
  ) {
    return null;
  }

  const account = await ctx.db.get(token.accountId);
  if (!account || account.status !== "active") return null;

  // A token is minted for an owner/admin; it must stop working the moment
  // that membership is removed or demoted, not when it expires.
  const user = await userForAuthId(ctx, token.authId);
  const membership = user
    ? await getOrgMembership(ctx, token.orgId, user._id)
    : null;
  if (!membership || !orgRoleMeets(membership.role, "admin")) return null;

  if (
    token.lastUsedAt === undefined ||
    now - token.lastUsedAt >= CLI_TOKEN_LAST_USED_WRITE_INTERVAL_MS
  ) {
    await ctx.db.patch(token._id, { lastUsedAt: now });
  }

  return { token: token, account: account };
}

async function uniqueOrgSlug(
  ctx: MutationCtx,
  baseName: string,
): Promise<string> {
  const baseSlug = slugifyName(baseName);
  let suffix = 0;
  while (true) {
    const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    const existing = await ctx.db
      .query("orgs")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!existing) return candidate;
    suffix += 1;
  }
}

async function userForAuthId(
  ctx: MutationCtx,
  authId: string,
): Promise<Doc<"users"> | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();

  return user ?? null;
}
