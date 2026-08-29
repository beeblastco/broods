/**
 * Storage mirror writes for sandbox snapshot/image build state. The account-manage
 * snapshot endpoint calls this after the provider captures a snapshot so the
 * dashboard's live sandboxSnapshots query reflects it. Fire-and-forget safe — wrapped
 * so a mirror failure never fails the request. See usage.ts for the same pattern.
 */

const internal: any = require("@broods/convex/_generated/api").internal;
import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { logError } from "../log.ts";
import { getConvexClient } from "./client.ts";

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
    logError("Sandbox snapshot mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
