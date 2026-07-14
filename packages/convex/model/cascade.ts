/**
 * Shared cascade-deletion helpers so every deletion path (project/org/account
 * removal and the WorkOS `user.deleted` webhook) fully purges linked rows instead
 * of leaking orphans. These are plain helpers, not Convex functions, to avoid
 * mutation→mutation calls and to keep one source of truth for the ownership graph.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteEnvironmentContents } from "../environment";

const ACCOUNT_DELETE_BATCH_SIZE = 100;
const accountScopedTables = [
    "agents",
    "accountTools",
    "accountHooks",
    "agentPolicies",
    "sandboxConfigs",
    "workspaceConfigs",
    "sandboxInstances",
    "sandboxSnapshots",
    "sandboxAuditEvents",
    "skills",
    "asyncResults",
    "runtimeConversationEvents",
    "runtimeClaims",
    "runtimeAsyncAgentResults",
    "runtimeAsyncToolResults",
    "runtimeAsyncToolGroups",
    "sandboxReservations",
    "conversations",
    "messages",
    "crons",
    "cliAuthCodes",
    "cliTokens",
    "cliExternalResources",
] as const;

/**
 * Delete an account and every account-scoped row (agents, conversations, CLI
 * tokens, crons, runs, tool/sandbox/workspace configs, skills, async results).
 * @param accountId the account to purge
 */
export async function deleteAccountContents(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
): Promise<void> {
    for (const table of accountScopedTables) {
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

    const auditEvents = await ctx.db
        .query("configAuditEvents")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .collect();
    for (const event of auditEvents) await ctx.db.delete(event._id);

    const taskUsage = await ctx.db
        .query("taskUsage")
        .withIndex("by_accountId_and_finishedAt", (q) => q.eq("accountId", accountId))
        .collect();
    for (const task of taskUsage) await ctx.db.delete(task._id);

    const usageRollups = await ctx.db
        .query("usageRollups")
        .withIndex("by_accountId_endpointId_bucketStart_modelProvider_modelId", (q) => q.eq("accountId", accountId))
        .collect();
    for (const rollup of usageRollups) await ctx.db.delete(rollup._id);

    await ctx.db.delete(accountId);
}

/**
 * Deletes one bounded batch of account data. Call repeatedly until it returns
 * true to avoid exceeding Convex transaction limits for high-volume accounts.
 * @param accountId account whose rows are being removed
 * @returns true once the account row itself has been deleted
 */
export async function deleteAccountContentsBatch(
    ctx: MutationCtx,
    accountId: Id<"accounts">,
): Promise<boolean> {
    const account = await ctx.db.get(accountId);
    if (!account) return true;

    for (const table of accountScopedTables) {
        const rows = await ctx.db
            .query(table)
            .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
            .take(ACCOUNT_DELETE_BATCH_SIZE);
        if (rows.length > 0) {
            for (const row of rows) await ctx.db.delete(row._id);

            return false;
        }
    }

    const cronRuns = await ctx.db
        .query("cronRuns")
        .withIndex("by_accountId_and_cronId_and_startedAt", (q) => q.eq("accountId", accountId))
        .take(ACCOUNT_DELETE_BATCH_SIZE);
    if (cronRuns.length > 0) {
        for (const run of cronRuns) await ctx.db.delete(run._id);

        return false;
    }

    const auditEvents = await ctx.db
        .query("configAuditEvents")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .take(ACCOUNT_DELETE_BATCH_SIZE);
    if (auditEvents.length > 0) {
        for (const event of auditEvents) await ctx.db.delete(event._id);

        return false;
    }

    const taskUsage = await ctx.db
        .query("taskUsage")
        .withIndex("by_accountId_and_finishedAt", (q) => q.eq("accountId", accountId))
        .take(ACCOUNT_DELETE_BATCH_SIZE);
    if (taskUsage.length > 0) {
        for (const task of taskUsage) await ctx.db.delete(task._id);

        return false;
    }

    const usageRollups = await ctx.db
        .query("usageRollups")
        .withIndex("by_accountId_endpointId_bucketStart_modelProvider_modelId", (q) => q.eq("accountId", accountId))
        .take(ACCOUNT_DELETE_BATCH_SIZE);
    if (usageRollups.length > 0) {
        for (const rollup of usageRollups) await ctx.db.delete(rollup._id);

        return false;
    }

    await ctx.db.delete(accountId);

    return true;
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

    // Personal CLI credentials must be revoked even when their org survives
    // because it has other members.
    const cliAuthCodes = await ctx.db
        .query("cliAuthCodes")
        .withIndex("by_authId", (q) => q.eq("authId", user.authId))
        .collect();
    for (const code of cliAuthCodes) await ctx.db.delete(code._id);

    const cliTokens = await ctx.db
        .query("cliTokens")
        .withIndex("by_authId", (q) => q.eq("authId", user.authId))
        .collect();
    for (const token of cliTokens) await ctx.db.delete(token._id);

    // Remove personal identifiers from retained shared-org audit records.
    const dashboardReveals = await ctx.db
        .query("environmentVariableReveals")
        .withIndex("by_revealedByAuthId", (q) => q.eq("revealedByAuthId", user.authId))
        .collect();
    for (const reveal of dashboardReveals) await ctx.db.delete(reveal._id);

    const cliReveals = await ctx.db
        .query("environmentVariableReveals")
        .withIndex("by_revealedByCliAuthId", (q) => q.eq("revealedByCliAuthId", user.authId))
        .collect();
    for (const reveal of cliReveals) await ctx.db.delete(reveal._id);

    // Pre-org records belong to the original single-user model. They have no
    // orgId, so they are safe to remove with their sole WorkOS owner.
    const legacyProjects = await ctx.db
        .query("projects")
        .withIndex("by_authId", (q) => q.eq("authId", user.authId))
        .collect();
    for (const project of legacyProjects) {
        if (!project.orgId) await purgeProject(ctx, project._id);
    }

    await ctx.db.delete(user._id);
}
