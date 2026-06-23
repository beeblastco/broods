/**
 * Shared cascade-deletion helpers so every deletion path (project/org/account
 * removal and the WorkOS `user.deleted` webhook) fully purges linked rows instead
 * of leaking orphans. These are plain helpers, not Convex functions, to avoid
 * mutation→mutation calls and to keep one source of truth for the ownership graph.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteEnvironmentContents } from "../environment";

/**
 * Delete an account and every account-scoped row (agents, conversations, CLI
 * tokens, crons, runs, tool/sandbox/workspace configs, skills, async results).
 * @param accountId the account to purge
 */
export async function deleteAccountContents(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
): Promise<void> {
    const accountScoped = [
        "agents",
        "accountTools",
        "sandboxConfigs",
        "workspaceConfigs",
        "skills",
        "asyncResults",
        "conversations",
        "messages",
        "crons",
        "cliAuthCodes",
        "cliTokens",
        "cliExternalResources",
    ] as const;
    for (const table of accountScoped) {
        const rows = await ctx.db
            .query(table)
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .collect();
        for (const row of rows) await ctx.db.delete(row._id);
    }

    // cronRuns is account-scoped via a composite index (accountId is the prefix).
    const cronRuns = await ctx.db
        .query("cronRuns")
        .withIndex("by_accountId_and_cronId_and_startedAt", (q) => q.eq("accountId", accountId))
        .collect();
    for (const run of cronRuns) await ctx.db.delete(run._id);

    await ctx.db.delete(accountId);
}

/**
 * Delete a project, its environments + their contents, and its workspace files
 * (including stored blobs).
 * @param projectId the project to purge
 */
export async function purgeProject(
    ctx: MutationCtx,
    projectId: Id<"projects">,
): Promise<void> {
    const environments = await ctx.db
        .query("environments")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
        .collect();
    for (const environment of environments) {
        await deleteEnvironmentContents(ctx, environment);
        await ctx.db.delete(environment._id);
    }

    const files = await ctx.db
        .query("workspaceFiles")
        .withIndex("by_projectId_and_nodeId", (q) => q.eq("projectId", projectId))
        .collect();
    for (const file of files) {
        if (file.storageId) await ctx.storage.delete(file.storageId);
        await ctx.db.delete(file._id);
    }

    await ctx.db.delete(projectId);
}

/**
 * Delete an org and everything beneath it: its projects, its account, and its
 * memberships.
 * @param orgId the org to purge
 */
export async function purgeOrg(ctx: MutationCtx, orgId: Id<"orgs">): Promise<void> {
    const projects = await ctx.db
        .query("projects")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect();
    for (const project of projects) await purgeProject(ctx, project._id);

    const accounts = await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect();
    for (const account of accounts) await deleteAccountContents(ctx, account._id);

    const members = await ctx.db
        .query("orgMembers")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect();
    for (const member of members) await ctx.db.delete(member._id);

    await ctx.db.delete(orgId);
}

/**
 * Purge a user: fully delete the orgs they solely own, drop their membership from
 * any shared org (ownership transfer is intentionally out of scope), then delete
 * the user row. Used by the WorkOS `user.deleted` webhook.
 * @param user the user document to purge
 */
export async function purgeUser(ctx: MutationCtx, user: Doc<"users">): Promise<void> {
    const ownedOrgs = await ctx.db
        .query("orgs")
        .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", user.authId))
        .collect();

    const purgedOrgIds = new Set<Id<"orgs">>();
    for (const org of ownedOrgs) {
        const members = await ctx.db
            .query("orgMembers")
            .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
            .collect();
        const others = members.filter((m) => m.userId !== user._id);
        if (others.length === 0) {
            await purgeOrg(ctx, org._id);
            purgedOrgIds.add(org._id);
        }
    }

    // Drop the user's memberships in any org that wasn't fully purged (shared orgs
    // they owned, plus orgs owned by others), so no membership dangles on the
    // deleted user.
    const memberships = await ctx.db
        .query("orgMembers")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .collect();
    for (const membership of memberships) {
        if (!purgedOrgIds.has(membership.orgId)) await ctx.db.delete(membership._id);
    }

    await ctx.db.delete(user._id);
}
