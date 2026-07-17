/** Account deletion cleanup across Convex runtime state and S3 workspaces. */

import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../harness/sandbox/s3-mount.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type { AccountRecord } from "../shared/domain/accounts.ts";
import type { WorkspaceStorageConfig } from "../shared/domain/workspace-config.ts";
import { optionalEnv } from "../shared/env.ts";
import { deleteS3Prefix } from "../shared/s3.ts";
import { releaseReservedSandboxes } from "../shared/sandbox-cleanup.ts";
import { getStorage } from "../shared/storage.ts";
import { workspaceNamespace } from "../shared/workspaces.ts";

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
  const reservedSandboxesReleased = await releaseReservedSandboxes(
    account.accountId,
    workspaces.map((w) => workspaceNamespace(account.accountId, w.workspaceId)),
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
    filesystemObjectsDeleted,
    reservedSandboxesReleased,
  };
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
    >("deleteAccountRuntimeData", { accountId });
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
