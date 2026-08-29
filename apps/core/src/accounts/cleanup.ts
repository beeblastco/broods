/**
 * Account deletion cleanup across Convex runtime state and the account's S3
 * prefixes (workspaces, skills, tool/hook bundles). CRUD for these resources
 * lives in the Convex config plane; only the deletion sweep belongs here.
 */

import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../harness/sandbox/s3-mount.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type { AccountRecord } from "../shared/domain/accounts.ts";
import type { WorkspaceStorageConfig } from "../shared/domain/workspace-config.ts";
import { optionalEnv, requireEnv } from "../shared/env.ts";
import { deleteS3Prefix } from "../shared/s3.ts";
import { releaseReservedSandboxes } from "../shared/sandbox-cleanup.ts";
import { skillsBucketName } from "../shared/skills.ts";
import { getStorage } from "../shared/storage.ts";
import {
  agentSandboxReservation,
  workspaceNamespace,
} from "../shared/workspaces.ts";

const ACCOUNT_RUNTIME_DELETE_MAX_BATCHES = 100;

export interface AccountCleanupSummary {
  conversationsDeleted: number;
  processedEventsDeleted: number;
  asyncAgentResultDeleted: number;
  asyncToolResultDeleted: number;
  asyncToolGroupDeleted: number;
  sandboxReservationDeleted: number;
  filesystemObjectsDeleted: number;
  reservedSandboxesReleased: number;
}

export async function deleteAccountRuntimeData(
  account: AccountRecord,
): Promise<AccountCleanupSummary> {
  const workspaces = await getStorage().workspaceConfigs.list(
    account.accountId,
  );
  // Workspaces reserve on their namespace, agent-level sandboxes on a derived
  // key; miss either list and machines leak at the provider.
  const reservedSandboxesReleased = await releaseReservedSandboxes(
    account.accountId,
    [
      ...workspaces.map((w) =>
        workspaceNamespace(account.accountId, w.workspaceId),
      ),
      ...(await agentSandboxReservationKeys(account.accountId)),
    ],
  );
  const [runtimeDeleted, filesystemObjectsDeleted] = await Promise.all([
    deleteConvexRuntimeRows(account.accountId),
    deleteWorkspaceFilesystems(account.accountId, workspaces),
  ]);
  await Promise.all([
    getStorage().sandboxConfigs.removeAllForAccount(account.accountId),
    getStorage().workspaceConfigs.removeAllForAccount(account.accountId),
  ]);

  return {
    ...runtimeDeleted,
    filesystemObjectsDeleted: filesystemObjectsDeleted,
    reservedSandboxesReleased: reservedSandboxesReleased,
  };
}

export async function deleteAccountSkills(accountId: string): Promise<number> {
  return deleteS3Prefix(skillsBucketName(), `${accountId}/`);
}

// Bundle metadata lives in Convex; only the executable module bytes are stored
// under these account-prefixed S3 keys.
export async function deleteAccountToolBundles(
  accountId: string,
): Promise<number> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const encodedAccountId = encodeURIComponent(accountId);
  const [toolsDeleted, hooksDeleted] = await Promise.all([
    deleteS3Prefix(bucket, `account-tools/${encodedAccountId}/`),
    deleteS3Prefix(bucket, `account-hooks/${encodedAccountId}/`),
    deleteS3Prefix(bucket, `account-mcp/${encodedAccountId}/`),
  ]);

  return toolsDeleted + hooksDeleted;
}

export async function deleteWorkspaceFilesystem(
  accountId: string,
  workspaceId: string,
  storage: WorkspaceStorageConfig | undefined,
): Promise<number> {
  if (!storage?.bucket && !optionalEnv("FILESYSTEM_BUCKET_NAME")) return 0;
  const target = await resolveS3ReadTarget(
    workspaceReadContext(storage, workspaceNamespace(accountId, workspaceId)),
  );

  return deleteS3Prefix(target.bucket, target.prefix, target.access);
}

/**
 * The reservation keys this account's agents hold on their own sandboxes. Asks
 * `agentSandboxReservation` so a pinned key releases the machine actually reserved.
 */
async function agentSandboxReservationKeys(
  accountId: string,
): Promise<string[]> {
  const agents = await getStorage().agents.list(accountId);
  const keys = await Promise.all(
    agents.map(async (agent): Promise<string | undefined> => {
      const sandboxId = agent.config.sandbox;
      if (typeof sandboxId !== "string" || sandboxId.length === 0) {
        return undefined;
      }
      const record = await getStorage().sandboxConfigs.getById(
        accountId,
        sandboxId,
      );
      if (!record) {
        return undefined;
      }

      return agentSandboxReservation(
        record.config,
        accountId,
        agent.agentId,
        sandboxId,
      );
    }),
  );

  return keys.filter((key): key is string => key !== undefined);
}

async function deleteConvexRuntimeRows(
  accountId: string,
): Promise<
  Omit<
    AccountCleanupSummary,
    "filesystemObjectsDeleted" | "reservedSandboxesReleased"
  >
> {
  const totals = {
    conversationsDeleted: 0,
    processedEventsDeleted: 0,
    asyncAgentResultDeleted: 0,
    asyncToolResultDeleted: 0,
    asyncToolGroupDeleted: 0,
    sandboxReservationDeleted: 0,
  };
  for (
    let batchNumber = 0;
    batchNumber < ACCOUNT_RUNTIME_DELETE_MAX_BATCHES;
    batchNumber += 1
  ) {
    const batch = await runtime.mutate<
      typeof totals & { totalDeleted: number }
    >("deleteAccountRuntimeData", { accountId: accountId });
    totals.conversationsDeleted += batch.conversationsDeleted;
    totals.processedEventsDeleted += batch.processedEventsDeleted;
    totals.asyncAgentResultDeleted += batch.asyncAgentResultDeleted;
    totals.asyncToolResultDeleted += batch.asyncToolResultDeleted;
    totals.asyncToolGroupDeleted += batch.asyncToolGroupDeleted;
    totals.sandboxReservationDeleted += batch.sandboxReservationDeleted;
    if (batch.totalDeleted === 0) return totals;
  }

  throw new Error(
    `Account runtime cleanup exceeded ${ACCOUNT_RUNTIME_DELETE_MAX_BATCHES} Convex batches; retry deletion to continue`,
  );
}

async function deleteWorkspaceFilesystems(
  accountId: string,
  workspaces: Array<{
    workspaceId: string;
    config: { storage?: WorkspaceStorageConfig };
  }>,
): Promise<number> {
  let deleted = 0;
  for (const workspace of workspaces)
    deleted += await deleteWorkspaceFilesystem(
      accountId,
      workspace.workspaceId,
      workspace.config.storage,
    );

  return deleted;
}
