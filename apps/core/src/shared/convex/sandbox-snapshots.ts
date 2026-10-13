/**
 * Storage reads and writes for sandbox snapshot/image rows. The account-manage
 * snapshot endpoint records each capture here, with the stage of the sandbox
 * it came from, and every executor reads the row before booting a snapshot.
 */

import type { SandboxScope } from "@broods/convex/model/sandboxRules";
import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { adminMutation, adminQuery, internal } from "./client.ts";

/** Unified (Daytona-aligned) snapshot build status; mirrors sandboxSnapshotsFields.status. */
export type SandboxSnapshotStatus =
  | "pending"
  | "building"
  | "pulling"
  | "active"
  | "inactive"
  | "error"
  | "build_failed";

/** The registry row for one provider image: who took it, where, and from what. */
export interface SandboxSnapshotRecord {
  accountId: string;
  /** Absent on a snapshot taken before snapshots recorded their stage. */
  scope?: SandboxScope;
  baseImage: string;
  status: SandboxSnapshotStatus;
}

/**
 * The row registering one provider image, the account's own first, or null
 * when no account registered it (a provider image, not a Broods snapshot).
 * Executors refuse to boot a row of another account or stage, and the snapshot
 * verb reads the variant a pinned snapshot was built from.
 */
export async function findSandboxSnapshot(
  accountId: string | undefined,
  externalImageId: string,
): Promise<SandboxSnapshotRecord | null> {
  return adminQuery(internal.sandbox.snapshots.findByImage, {
    ...(accountId ? { accountId: accountId } : {}),
    externalImageId: externalImageId,
  });
}

/**
 * Records a captured snapshot, or its build-status change, in Convex.
 * Idempotent by (account, scope, name). A failed write throws: the row is what
 * locks the image to its stage, so a capture it does not record must not be
 * handed back as a success.
 */
export async function upsertSandboxSnapshot(input: {
  accountId: string;
  scope: SandboxScope;
  name: string;
  provider: SandboxProvider;
  baseImage: string;
  externalImageId: string;
  status?: SandboxSnapshotStatus;
}): Promise<void> {
  await adminMutation(internal.sandbox.snapshots.upsert, {
    accountId: input.accountId,
    scope: input.scope,
    name: input.name,
    provider: input.provider,
    baseImage: input.baseImage,
    externalImageId: input.externalImageId,
    ...(input.status ? { status: input.status } : {}),
  });
}
