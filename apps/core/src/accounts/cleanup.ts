/** Account deletion cleanup across Convex runtime state and S3 workspaces. */

import type { AccountRecord } from "../shared/domain/accounts.ts";
import { getCoreStore } from "../shared/core-store.ts";
import { deleteS3Prefix } from "../shared/s3.ts";
import type { WorkspaceStorageConfig } from "../shared/domain/workspace-config.ts";
import { optionalEnv } from "../shared/env.ts";
import { workspaceNamespace } from "../shared/workspaces.ts";
import { releaseReservedSandboxes } from "../shared/sandbox-cleanup.ts";
import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../harness/sandbox/s3-mount.ts";
import { runtimeMutation } from "../shared/convex/runtime.ts";

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
  const workspaces = await getCoreStore().workspaceConfigs.list(account.accountId);
  const reservedSandboxesReleased = await releaseReservedSandboxes(
    account.accountId,
    workspaces.map((w) => workspaceNamespace(account.accountId, w.workspaceId)),
  );
  const [runtime, filesystemObjectsDeleted] = await Promise.all([
    deleteConvexRuntimeRows(account.accountId),
    deleteWorkspaceFilesystems(account.accountId, workspaces),
  ]);
  await Promise.all([
    getCoreStore().sandboxConfigs.removeAllForAccount(account.accountId),
    getCoreStore().workspaceConfigs.removeAllForAccount(account.accountId),
  ]);
  return { ...runtime, filesystemObjectsDeleted, reservedSandboxesReleased };
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
  for (;;) {
    const batch = await runtimeMutation<
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
