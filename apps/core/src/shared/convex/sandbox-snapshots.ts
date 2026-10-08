/**
 * Storage mirror writes for sandbox snapshot/image build state. The account-manage
 * snapshot endpoint calls this after the provider captures a snapshot so the
 * dashboard's live sandboxSnapshots query reflects it. A mirror outage never fails
 * the request; a refusal (a name another provider's snapshot holds) is rethrown.
 */

const internal: any = require("@broods/convex/_generated/api").internal;
import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { logError } from "../log.ts";
import { getConvexClient } from "./client.ts";
import { ConvexError } from "convex/values";

/** Unified (Daytona-aligned) snapshot build status; mirrors sandboxSnapshotsFields.status. */
export type SandboxSnapshotStatus =
  | "pending"
  | "building"
  | "pulling"
  | "active"
  | "inactive"
  | "error"
  | "build_failed";

/**
 * The account's snapshot row for one provider image, or null when it has none.
 * The lambda executor refuses to boot a snapshot image the account does not own,
 * and the snapshot verb reads the variant a pinned snapshot was built from.
 */
export async function findSandboxSnapshot(
  accountId: string,
  externalImageId: string,
): Promise<{ baseImage: string; status: SandboxSnapshotStatus } | null> {
  return getConvexClient().query(internal.sandbox.snapshots.findByImage, {
    accountId: accountId,
    externalImageId: externalImageId,
  });
}

/**
 * Mirrors a captured/registered snapshot into Convex. Idempotent by (account, name).
 */
export async function upsertSandboxSnapshot(input: {
  accountId: string;
  name: string;
  provider: SandboxProvider;
  baseImage: string;
  externalImageId: string;
  status?: SandboxSnapshotStatus;
}): Promise<void> {
  try {
    await getConvexClient().mutation(internal.sandbox.snapshots.upsert, {
      accountId: input.accountId as any,
      name: input.name,
      provider: input.provider,
      baseImage: input.baseImage,
      externalImageId: input.externalImageId,
      ...(input.status ? { status: input.status } : {}),
    });
  } catch (err) {
    if (err instanceof ConvexError) throw err;
    logError("Sandbox snapshot mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
