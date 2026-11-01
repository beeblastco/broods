import {
  resolveS3ReadTarget,
  workspaceReadContext,
} from "../harness/sandbox/s3-mount.ts";
import type { ReservedSandbox } from "../harness/sandbox/types.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type { AccountRecord } from "../shared/domain/accounts.ts";
import type { WorkspaceStorageConfig } from "../shared/domain/workspace-config.ts";
import { optionalEnv, requireEnv } from "../shared/env.ts";
import { attachmentStorePrefix } from "../shared/media-ticket.ts";
import { deleteS3Prefix } from "../shared/s3.ts";
import { releaseReservedSandboxes } from "../shared/sandbox-cleanup.ts";
import { skillsBucketName } from "../shared/skills.ts";
import { getStorage } from "../shared/storage.ts";
import { workspaceNamespace } from "../shared/workspaces.ts";

const ACCOUNT_RUNTIME_DELETE_MAX_BATCHES = 100;

export interface AccountCleanupSummary {
  conversationsDeleted: number;
  processedEventsDeleted: number;
  asyncAgentResultDeleted: number;
  asyncToolResultDeleted: number;
  sandboxReservationDeleted: number;
  filesystemObjectsDeleted: number;
  reservedSandboxesReleased: number;
}

interface SandboxReservationPage {
  page: ReservedSandbox[];
  cursor: string | null;
  isDone: boolean;
}

export async function deleteAccountAttachments(
  accountId: string,
): Promise<number> {
  const bucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!bucket) return 0;

  return deleteS3Prefix(bucket, attachmentStorePrefix(accountId));
}

export async function deleteAccountBundles(accountId: string): Promise<number> {
  const bucket = requireEnv("TOOL_BUNDLES_BUCKET_NAME");
  const encodedAccountId = encodeURIComponent(accountId);
  const [hooks, mcp] = await Promise.all([
    deleteS3Prefix(bucket, `account-hooks/${encodedAccountId}/`),
    deleteS3Prefix(bucket, `account-mcp/${encodedAccountId}/`),
  ]);

  return hooks + mcp;
}

export async function deleteAccountRuntimeData(
  account: AccountRecord,
): Promise<AccountCleanupSummary> {
  const workspaces = await getStorage().workspaceConfigs.list(
    account.accountId,
  );
  // Stored keys, read before the cascade: keys derived from configs miss isolated and harness ones.
  const reservationKeys = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: SandboxReservationPage = await runtime.query(
      "listAccountSandboxReservations",
      { accountId: account.accountId, cursor: cursor },
    );
    for (const row of page.page) reservationKeys.add(row.reservationKey);
    cursor = page.isDone ? null : page.cursor;
  } while (cursor !== null);
  const reservedSandboxesReleased = await releaseReservedSandboxes(
    account.accountId,
    [...reservationKeys],
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
    sandboxReservationDeleted: 0,
  };
  for (
    let batchNumber = 0;
    batchNumber < ACCOUNT_RUNTIME_DELETE_MAX_BATCHES;
    batchNumber += 1
  ) {
    const batch = await runtime.mutate("deleteAccountRuntimeData", {
      accountId: accountId,
    });
    totals.conversationsDeleted += batch.conversationsDeleted;
    totals.processedEventsDeleted += batch.processedEventsDeleted;
    totals.asyncAgentResultDeleted += batch.asyncAgentResultDeleted;
    totals.asyncToolResultDeleted += batch.asyncToolResultDeleted;
    totals.sandboxReservationDeleted += batch.sandboxReservationDeleted;
    if (batch.totalDeleted === 0) return totals;
  }

  throw new Error(
    `Account runtime cleanup exceeded ${ACCOUNT_RUNTIME_DELETE_MAX_BATCHES} Convex batches; retry deletion to continue`,
  );
}

async function deleteWorkspaceFilesystem(
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
