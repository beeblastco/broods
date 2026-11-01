// Plain helpers, not Convex functions, so no mutation calls another mutation.

import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { deleteStageContents } from "../stage";
import { unregisterSchedule } from "./cronSchedules";
import { releaseSeat } from "./orgBilling";
import { isManagedService } from "./planLimits";
import { lockImage } from "./snapshotLocks";

const ACCOUNT_DELETE_BATCH_SIZE = 100;
const accountScopedReads: ReadonlyArray<
  (
    ctx: MutationCtx,
    accountId: Id<"accounts">,
  ) => Promise<Array<{ _id: Id<TableNames> }>>
> = [
  (ctx, accountId) =>
    ctx.db
      .query("agents")
      .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("accountHooks")
      .withIndex("by_accountId_and_status", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("agentPolicies")
      .withIndex("by_accountId_and_status", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  // Rows with no stage outlive every project purge; only this drain removes them.
  (ctx, accountId) =>
    ctx.db
      .query("accountEnvVars")
      .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("connections")
      .withIndex("by_accountId_and_type", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("accountKeys")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("accountRoles")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("accountApiKeys")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("channelRecords")
      .withIndex("by_accountId_and_status", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("mcp")
      .withIndex("by_accountId_and_status", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("uploadGrants")
      .withIndex("by_accountId_and_expiresAt", (q) =>
        q.eq("accountId", accountId),
      )
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("sandboxConfigs")
      .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("workspaceDownloadTokens")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("sandboxInstances")
      .withIndex("by_accountId_projectId_and_stageId", (q) =>
        q.eq("accountId", accountId),
      )
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("machineConnections")
      .withIndex("by_accountId_projectId_and_stageId", (q) =>
        q.eq("accountId", accountId),
      )
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  // The image stays locked after its row goes, so it never boots for another account.
  async (ctx, accountId) => {
    const rows = await ctx.db
      .query("sandboxSnapshots")
      .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE);
    for (const row of rows) await lockImage(ctx, row);

    return rows;
  },
  (ctx, accountId) =>
    ctx.db
      .query("sandboxAuditEvents")
      .withIndex("by_accountId_and_reservationKey_and_createdAt", (q) =>
        q.eq("accountId", accountId),
      )
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("auditEvents")
      .withIndex("by_accountId_and_seq", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("auditChainHeads")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("auditSinks")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("channelEndpoints")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("runtimeConversationCoordinators")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("runtimeClaims")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("runtimeAsyncAgentResults")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("runtimeAsyncToolResults")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("sandboxReservations")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("cliAuthCodes")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("cliTokens")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("cliExternalResources")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("usageMeters")
      .withIndex("by_accountId_and_month", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("usageDays")
      .withIndex("by_accountId_and_day", (q) => q.eq("accountId", accountId))
      .take(ACCOUNT_DELETE_BATCH_SIZE),
  (ctx, accountId) =>
    ctx.db
      .query("usageProjectDays")
      .withIndex("by_accountId_and_day_and_projectId", (q) =>
        q.eq("accountId", accountId),
      )
      .take(ACCOUNT_DELETE_BATCH_SIZE),
];

// Call until it returns true: one batch per transaction keeps within Convex limits.
export async function deleteAccountContentsBatch(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<boolean> {
  const account = await ctx.db.get(accountId);
  if (!account) return true;

  // Crons go first, schedule and row together: a live schedule could fire into the
  // teardown, and a row deleted alone would leave its schedule firing at nothing.
  const crons = await ctx.db
    .query("crons")
    .withIndex("by_accountId_and_agentId", (q) => q.eq("accountId", accountId))
    .take(ACCOUNT_DELETE_BATCH_SIZE);
  if (crons.length > 0) {
    for (const cron of crons) {
      await unregisterSchedule(ctx, cron);
      await ctx.db.delete(cron._id);
    }

    return false;
  }

  for (const read of accountScopedReads) {
    const rows = await read(ctx, accountId);
    if (rows.length > 0) {
      for (const row of rows) await ctx.db.delete(row._id);

      return false;
    }
  }

  const cronRuns = await ctx.db
    .query("cronRuns")
    .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
      q.eq("accountId", accountId),
    )
    .take(ACCOUNT_DELETE_BATCH_SIZE);
  if (cronRuns.length > 0) {
    for (const run of cronRuns) await ctx.db.delete(run._id);

    return false;
  }

  const taskUsage = await ctx.db
    .query("taskUsage")
    .withIndex("by_accountId_and_taskId", (q) => q.eq("accountId", accountId))
    .take(ACCOUNT_DELETE_BATCH_SIZE);
  if (taskUsage.length > 0) {
    for (const task of taskUsage) await ctx.db.delete(task._id);

    return false;
  }

  const usageRollups = await ctx.db
    .query("usageRollups")
    .withIndex(
      "by_accountId_endpointId_grain_bucketStart_modelProvider_modelId",
      (q) => q.eq("accountId", accountId),
    )
    .take(ACCOUNT_DELETE_BATCH_SIZE);
  if (usageRollups.length > 0) {
    for (const rollup of usageRollups) await ctx.db.delete(rollup._id);

    return false;
  }

  await ctx.db.delete(accountId);

  return true;
}

// A blob already gone is skipped, so one stale row cannot block a whole purge.
export async function deleteWorkspaceFile(
  ctx: MutationCtx,
  file: Doc<"workspaceFiles">,
): Promise<void> {
  if (file.storageId && (await ctx.db.system.get(file.storageId))) {
    await ctx.storage.delete(file.storageId);
  }
  await ctx.db.delete(file._id);
}

export async function purgeProject(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<void> {
  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .collect();
  for (const stage of stages) {
    await deleteStageContents(ctx, stage);
    await ctx.db.delete(stage._id);
  }

  const files = await ctx.db
    .query("workspaceFiles")
    .withIndex("by_projectId_nodeId_and_path", (q) =>
      q.eq("projectId", projectId),
    )
    .collect();
  for (const file of files) await deleteWorkspaceFile(ctx, file);

  await ctx.db.delete(projectId);
}

export async function purgeOrg(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
): Promise<void> {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
    .collect();
  for (const project of projects) await purgeProject(ctx, project._id);

  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();
  // Account contents can outgrow one transaction, so `accounts.remove` drains them in batches.
  for (const account of accounts) {
    await ctx.scheduler.runAfter(0, internal.account.accounts.remove, {
      accountId: account._id,
    });
  }

  const members = await ctx.db
    .query("orgMembers")
    .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
    .collect();
  for (const member of members) await ctx.db.delete(member._id);

  await releaseSeat(ctx, orgId);
  await ctx.db.delete(orgId);
}

// Purges only orgs the user solely owns; shared orgs keep going without ownership transfer.
export async function purgeUser(
  ctx: MutationCtx,
  user: Doc<"users">,
): Promise<void> {
  const ownedOrgs = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", user.authId))
    .collect();
  if (isManagedService()) {
    await ctx.scheduler.runAfter(
      0,
      internal.stripe.cancelUserSubscriptionsInternal,
      { authId: user.authId },
    );
  }

  const purgedOrgIds = new Set<Id<"orgs">>();
  for (const org of ownedOrgs) {
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", org._id))
      .collect();
    const others = members.filter((m) => m.userId !== user._id);
    if (others.length === 0) {
      await purgeOrg(ctx, org._id);
      purgedOrgIds.add(org._id);
    }
  }

  const memberships = await ctx.db
    .query("orgMembers")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .collect();
  for (const membership of memberships) {
    if (purgedOrgIds.has(membership.orgId)) continue;
    await ctx.db.delete(membership._id);
    await releaseSeat(ctx, membership.orgId);
  }

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

  // Shared orgs keep their audit records; strip this user's identity from them.
  const dashboardReveals = await ctx.db
    .query("environmentVariableReveals")
    .withIndex("by_revealedByAuthId", (q) =>
      q.eq("revealedByAuthId", user.authId),
    )
    .collect();
  for (const reveal of dashboardReveals) await ctx.db.delete(reveal._id);

  const cliReveals = await ctx.db
    .query("environmentVariableReveals")
    .withIndex("by_revealedByCliAuthId", (q) =>
      q.eq("revealedByCliAuthId", user.authId),
    )
    .collect();
  for (const reveal of cliReveals) await ctx.db.delete(reveal._id);

  await ctx.db.delete(user._id);
}
